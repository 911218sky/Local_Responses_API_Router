import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { normalizeConfig } from "../config/data-store"
import type { RouterConfig } from "../core/types"
import { ProxyService } from "../router/proxy-service"
import {
  DEFAULT_CODEX_PROFILE,
  recordResponseContext,
  resetResponseContexts,
  responseContextCacheSize,
  transformToCodex,
} from "../router/transformer"
import { RequestLogStore } from "../storage/request-log"
import { ResponseContextStore } from "../storage/response-context"
import { RouterDatabase } from "../storage/sqlite-store"

test("Given unbounded service settings, When config is normalized, Then non-negative integers are preserved", () => {
  const config = normalizeConfig({
    retryCount: 101,
    capacityRetryCount: 102,
    retryDelayMs: 30_001,
    activeRequestTimeoutMs: 3_600_001,
  })

  expect(config.retryCount).toBe(101)
  expect(config.capacityRetryCount).toBe(102)
  expect(config.retryDelayMs).toBe(30_001)
  expect(config.activeRequestTimeoutMs).toBe(3_600_001)

  const disabled = normalizeConfig({
    retryCount: 0,
    capacityRetryCount: 0,
    retryDelayMs: 0,
    activeRequestTimeoutMs: 0,
  })

  expect(disabled.retryCount).toBe(0)
  expect(disabled.capacityRetryCount).toBe(0)
  expect(disabled.retryDelayMs).toBe(0)
  expect(disabled.activeRequestTimeoutMs).toBe(0)
})

test("Given a JSON response, When the store is reloaded, Then previous_response_id restores its history", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "router-json-context-"))
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ id: "json-response", output: [{ type: "message", role: "assistant" }] }))
  })
  await listen(upstream)
  const upstreamPort = serverPort(upstream)
  const config = routerConfig(`http://127.0.0.1:${upstreamPort}`, true)
  const logs = new RequestLogStore(dataDirectory, () => true)
  const contexts = new ResponseContextStore(dataDirectory, () => true)
  const proxy = new ProxyService(() => config, logs, contexts)
  try {
    await proxy.start()
    const status = await post(proxy, { input: [{ type: "message", role: "user" }], stream: false })
    expect(status).toBe(200)
    const reloaded = new ResponseContextStore(dataDirectory, () => true)
    expect(reloaded.getHistory("json-response")).toEqual([
      { type: "message", role: "user" },
      { type: "message", role: "assistant" },
    ])
    const continuation = transformToCodex(
      { "x-interaction-id": "reload-test" },
      Buffer.from(JSON.stringify({ previous_response_id: "json-response", input: [] })),
      "/responses",
      DEFAULT_CODEX_PROFILE,
      reloaded,
    )
    expect(continuation.trace.mode).toBe("continuation")
    expect(continuation.request.input).toEqual([
      { type: "message", role: "user" },
      { type: "message", role: "assistant" },
    ])
  } finally {
    await proxy.stop()
    await close(upstream)
  }
})

test("Given an SSE response, When the stream completes, Then context persistence happens once with final output", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "router-sse-context-"))
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write('data: {"type":"response.created","response":{"id":"sse-response"}}\n\n')
    response.write(
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call","arguments":""}}\n\n',
    )
    response.write('data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{}"}\n\n')
    response.write(
      'data: {"type":"response.completed","response":{"id":"sse-response","output":[{"type":"function_call","call_id":"call","arguments":"{}","status":"completed"}]}}\n\n',
    )
    response.end()
  })
  await listen(upstream)
  const config = routerConfig(`http://127.0.0.1:${serverPort(upstream)}`, true)
  const logs = new RequestLogStore(dataDirectory, () => true)
  const contexts = new ResponseContextStore(dataDirectory, () => true)
  let writes = 0
  contexts.on("changed", (event: unknown) => {
    if (typeof event === "object" && event !== null && "type" in event) {
      const type: unknown = event.type
      if (type === "created" || type === "updated") writes += 1
    }
  })
  const proxy = new ProxyService(() => config, logs, contexts)
  try {
    await proxy.start()
    expect(await post(proxy, { input: [], stream: true })).toBe(200)
    expect(writes).toBe(1)
    expect(contexts.getHistory("sse-response")?.at(-1)).toEqual({
      type: "function_call",
      call_id: "call",
      arguments: "{}",
      status: "completed",
    })
  } finally {
    await proxy.stop()
    await close(upstream)
  }
})

test("Given an upstream error response, When the request completes, Then no response context is persisted", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "router-error-context-"))
  const upstream = http.createServer((_request, response) => {
    response.writeHead(400, { "content-type": "application/json" })
    response.end(JSON.stringify({ id: "error-response", output: [{ type: "message", role: "assistant" }] }))
  })
  await listen(upstream)
  const config = routerConfig(`http://127.0.0.1:${serverPort(upstream)}`, true)
  const logs = new RequestLogStore(dataDirectory, () => true)
  const contexts = new ResponseContextStore(dataDirectory, () => true)
  const proxy = new ProxyService(() => config, logs, contexts)
  try {
    await proxy.start()
    expect(await post(proxy, { input: [{ type: "message", role: "user" }], stream: false })).toBe(400)
    expect(contexts.get("error-response")).toBeNull()
  } finally {
    await proxy.stop()
    await close(upstream)
  }
})

test("Given a partial SSE response, When the router is stopped, Then cancellation leaves no response context", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "router-cancel-context-"))
  let requestStarted = (): void => undefined
  const started = new Promise<void>((resolve) => {
    requestStarted = resolve
  })
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write('data: {"type":"response.created","response":{"id":"cancelled-response"}}\n\n')
    response.write(
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call","arguments":""}}\n\n',
    )
    requestStarted()
  })
  await listen(upstream)
  const config = routerConfig(`http://127.0.0.1:${serverPort(upstream)}`, true)
  const logs = new RequestLogStore(dataDirectory, () => true)
  const contexts = new ResponseContextStore(dataDirectory, () => true)
  const proxy = new ProxyService(() => config, logs, contexts)
  try {
    await proxy.start()
    const response = post(proxy, { input: [], stream: true })
    await started
    await proxy.stop()
    expect(await response).toBe(499)
    expect(contexts.get("cancelled-response")).toBeNull()
  } finally {
    await proxy.stop()
    await close(upstream)
  }
})

test("Given a partial SSE response, When the request times out, Then no response context is persisted", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "router-timeout-context-"))
  let requestStarted = (): void => undefined
  const started = new Promise<void>((resolve) => {
    requestStarted = resolve
  })
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write('data: {"type":"response.created","response":{"id":"timed-out-response"}}\n\n')
    response.write(
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call","arguments":""}}\n\n',
    )
    requestStarted()
  })
  await listen(upstream)
  const config: RouterConfig = {
    ...routerConfig(`http://127.0.0.1:${serverPort(upstream)}`, true),
    activeRequestTimeoutMs: 20,
  }
  const logs = new RequestLogStore(dataDirectory, () => true)
  const contexts = new ResponseContextStore(dataDirectory, () => true)
  const proxy = new ProxyService(() => config, logs, contexts)
  try {
    await proxy.start()
    const response = post(proxy, { input: [], stream: true })
    await started
    expect(await response).toBe(200)
    expect(logs.logs[0]?.errorCode).toBe("request_timeout")
    expect(contexts.get("timed-out-response")).toBeNull()
  } finally {
    await proxy.stop()
    await close(upstream)
  }
})

test("Given bounded context settings, When many volatile contexts are saved, Then old cache entries are evicted and clear removes them", async () => {
  resetResponseContexts()
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "router-cache-"))
  const contexts = new ResponseContextStore(dataDirectory, () => false)
  for (let index = 0; index < 505; index += 1) {
    recordResponseContext(`response-${index}`, [], [{ type: "message", index }], contexts, {})
  }
  expect(contexts.contexts.length).toBeLessThanOrEqual(500)
  expect(responseContextCacheSize()).toBeLessThanOrEqual(500)
  contexts.clear()
  expect(contexts.contexts).toEqual([])
  expect(responseContextCacheSize()).toBe(0)
})

test("Given an occupied router port, When start fails, Then status is stopped and retry succeeds", async () => {
  const occupied = http.createServer()
  await listen(occupied)
  const config = routerConfig("http://127.0.0.1:1", false, serverPort(occupied))
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "router-retry-"))
  const proxy = new ProxyService(
    () => config,
    new RequestLogStore(dataDirectory, () => false),
    new ResponseContextStore(dataDirectory, () => false),
  )
  await expect(proxy.start()).rejects.toMatchObject({ code: "EADDRINUSE" })
  expect(proxy.status().running).toBe(false)
  expect(proxy.server).toBeNull()
  await close(occupied)
  expect((await proxy.start()).running).toBe(true)
  await proxy.stop()
})

test("Given a router that is still starting, When stop is requested, Then no started timestamp remains", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "router-stop-starting-"))
  const config = routerConfig("http://127.0.0.1:1", false)
  const proxy = new ProxyService(
    () => config,
    new RequestLogStore(dataDirectory, () => false),
    new ResponseContextStore(dataDirectory, () => false),
  )
  const starting = proxy.start()
  const stopped = proxy.stop()
  await expect(starting).resolves.toMatchObject({ running: false })
  expect((await stopped).startedAt).toBeNull()
  expect(proxy.status().running).toBe(false)
})

test("Given shared SQLite stores, When traffic is cleared, Then logs and contexts are removed atomically", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "router-sqlite-"))
  const database = new RouterDatabase(dataDirectory)
  const logs = new RequestLogStore(dataDirectory, () => true, database)
  const contexts = new ResponseContextStore(dataDirectory, () => true, database)
  logs.create({ path: "/responses" })
  contexts.save("shared-response", [], [], {})
  database.clearTrafficData()
  expect(logs.logs).toEqual([])
  expect(contexts.contexts).toEqual([])
})

test("Given shared SQLite stores, When a log and its context are deleted in one transaction, Then both are removed", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "router-delete-transaction-"))
  const database = new RouterDatabase(dataDirectory)
  const logs = new RequestLogStore(dataDirectory, () => true, database)
  const contexts = new ResponseContextStore(dataDirectory, () => true, database)
  const logId = logs.create({ path: "/responses" })
  if (!logId) throw new Error("Expected a request log id.")
  contexts.save("linked-response", [], [], { logId })

  database.runTransaction(() => {
    logs.remove(logId)
    contexts.removeByLogIds([logId])
  })

  expect(logs.get(logId)).toBeNull()
  expect(contexts.get("linked-response")).toBeNull()
})

function routerConfig(baseUrl: string, transformEnabled: boolean, routerPort = 0): RouterConfig {
  return {
    dashboardPort: 0,
    routerPort,
    openBrowserOnLaunch: false,
    startRouterOnLaunch: false,
    forwardEnabled: true,
    transformEnabled,
    recordLogs: true,
    persistResponseContexts: true,
    clearLogsOnShutdown: false,
    retryCount: 0,
    capacityRetryCount: 0,
    retryDelayMs: 100,
    activeRequestTimeoutMs: 10_000,
    dashboardAuth: { enabled: false, username: "", passwordHash: "" },
    codexProfile: DEFAULT_CODEX_PROFILE,
    providers: [{ id: "test", slug: "test", name: "Test", baseUrl, enabled: true, routeOnly: !transformEnabled }],
  }
}

function post(proxy: ProxyService, body: Record<string, unknown>): Promise<number | undefined> {
  const address = proxy.server?.address()
  if (!address || typeof address === "string") throw new Error("Router is not listening.")
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port: address.port,
        path: "/test/v1/responses",
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      (response) => {
        response.resume()
        response.once("end", () => resolve(response.statusCode))
      },
    )
    request.once("error", reject)
    request.end(JSON.stringify(body))
  })
}

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
}

function serverPort(server: http.Server): number {
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected a TCP address.")
  return address.port
}
