import { test } from "bun:test"
import assert from "node:assert"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { isJsonArray, isJsonObject, type JsonArray, objectFromUnknown, type RouterConfig } from "../core/types"
import { isAllowedDashboardMutation } from "../dashboard/auth"
import { publicConfig, publicProvider, validateProvider } from "../dashboard/providers"
import { isCapacityError, ProxyService, shouldRetryUpstreamStatus } from "../router/proxy-service"
import { importCopilotTranscript } from "../router/transcript-importer"
import { applyCodexProfileHeaders, resetResponseContexts, transformToCodex } from "../router/transformer"
import { RequestLogStore } from "../storage/request-log"
import { ResponseContextStore } from "../storage/response-context"
import { RouterDatabase } from "../storage/sqlite-store"

const upstreamPort = 3124
const routerPort = 3123
interface SeenRequest {
  readonly url: string | undefined
  readonly headers: http.IncomingHttpHeaders
  readonly rawBody: Buffer
  readonly body: Record<string, unknown> | null
  readonly receivedAt: number
}

interface RawResponse {
  readonly statusCode: number | undefined
  readonly body: string
}

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] }
type ActiveRequest = ReturnType<ProxyService["status"]>["activeRequests"][number]

const seen: SeenRequest[] = []
let routeOnlyAttempts = 0
let capacityAttempts = 0
let persistentCapacityAttempts = 0
let responseRequestCount = 0
let disconnectBeforeDataAttempts = 0
let slowStreamStarted = 0
let resolveSlowHeaders: (() => void) | undefined
const slowHeadersReady = new Promise<void>((resolve) => {
  resolveSlowHeaders = resolve
})
let resolveSlowBodies: (() => void) | undefined
const slowBodiesReady = new Promise<void>((resolve) => {
  resolveSlowBodies = resolve
})
const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on("data", (chunk) => chunks.push(chunk))
  req.on("end", () => {
    const rawBody = Buffer.concat(chunks)
    let parsedBody: Record<string, unknown> | null = null
    try {
      const parsed = JSON.parse(rawBody.toString("utf8"))
      parsedBody = isJsonObject(parsed) ? parsed : null
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
    }
    seen.push({ url: req.url, headers: req.headers, rawBody, body: parsedBody, receivedAt: Date.now() })
    if (req.url === "/v1/chat/completions" && req.headers["x-interaction-id"] !== "converted-chat") {
      routeOnlyAttempts += 1
      if (routeOnlyAttempts < 3) {
        res.writeHead(503, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "retry me" }))
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (req.url === "/v1/chat/completions" && req.headers["x-interaction-id"] === "converted-chat") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (req.url === "/v1/capacity") {
      capacityAttempts += 1
      if (capacityAttempts < 3) {
        res.writeHead(503, { "content-type": "text/plain" })
        res.end("Selected model is at capacity. Please try a different model.")
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (req.url === "/v1/capacity-always") {
      persistentCapacityAttempts += 1
      res.writeHead(503, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: "Selected model is at capacity. Please try a different model." } }))
      return
    }
    if (req.url === "/v1/slow-responses" || req.url === "/v1/slow-route-only") {
      slowStreamStarted += 1
      if (slowStreamStarted === 3) resolveSlowHeaders?.()
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write(
          `data: ${JSON.stringify({ type: "response.completed", response: { id: `resp_slow_${slowStreamStarted}`, output: [] } })}\n\n`,
        )
        if (slowStreamStarted === 3) resolveSlowBodies?.()
        setTimeout(() => res.end(), 80)
      }, 40)
      return
    }
    if (req.headers.authorization === "Bearer invalid") {
      res.writeHead(401, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { code: "invalid_api_key", message: "Invalid token" } }))
      return
    }
    res.setHeader("set-cookie", "upstream-session=secret")
    if (req.url === "/v1/cancel-before") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ ok: true }))
      }, 250)
      return
    }
    if (req.url === "/v1/cancel-stream") {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write('data: {"type":"response.created","response":{"id":"resp_cancel"}}\n\n')
      setTimeout(() => res.end(), 250)
      return
    }
    if (req.url === "/v1/hang") {
      return
    }
    if (req.url === "/v1/disconnect-before-data") {
      disconnectBeforeDataAttempts += 1
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.flushHeaders()
      if (disconnectBeforeDataAttempts === 1) {
        res.destroy()
        return
      }
      res.end('data: {"type":"response.completed","response":{"id":"resp_retried","output":[]}}\n\n')
      return
    }
    if (req.url === "/v1/no-log-context") {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.end(
        'data: {"type":"response.completed","response":{"id":"resp_no_log","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"private"}]}]}}\n\n',
      )
      return
    }
    res.writeHead(200, { "content-type": "text/event-stream" })
    responseRequestCount += 1
    if (responseRequestCount === 1) {
      res.write('data: {"type":"response.created","response":{"id":"resp_test"}}\n\n')
      res.write(
        'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_test","call_id":"call_test","name":"list_dir","arguments":""}}\n\n',
      )
      res.write(
        'data: {"type":"response.function_call_arguments.done","output_index":0,"arguments":"{\\"path\\":\\".\\"}"}\n\n',
      )
    } else {
      res.write(
        'data: {"type":"response.completed","response":{"id":"resp_next","output":[],"usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":60}}}}\n\n',
      )
    }
    res.end()
  })
})

function post(pathname: string, payload: unknown, authorization = "Bearer test"): Promise<number | undefined> {
  return postRaw(pathname, Buffer.from(JSON.stringify(payload)), authorization)
}

function getRaw(pathname: string): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const request = http.get({ hostname: "127.0.0.1", port: routerPort, path: pathname, agent: false }, (response) => {
      const chunks: Buffer[] = []
      response.on("data", (chunk) => chunks.push(chunk))
      response.on("end", () =>
        resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }),
      )
    })
    request.setTimeout(3000, () => request.destroy(new Error(`Timed out requesting ${pathname}`)))
    request.on("error", reject)
  })
}

function postRaw(
  pathname: string,
  body: Buffer,
  authorization = "Bearer test",
  interactionId = "test-session",
  userAgent = "Incoming test UA",
): Promise<number | undefined> {
  return new Promise<number | undefined>((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port: routerPort,
        path: pathname,
        method: "POST",
        agent: false,
        headers: {
          authorization,
          "content-type": "application/json",
          "content-length": body.length,
          "x-interaction-id": interactionId,
          "user-agent": userAgent,
        },
      },
      (response) => {
        response.resume()
        response.on("end", () => resolve(response.statusCode))
      },
    )
    request.setTimeout(3000, () => request.destroy(new Error(`Timed out requesting ${pathname}`)))
    request.on("error", reject)
    request.end(body)
  })
}

function startRaw(
  pathname: string,
  body: Buffer,
  interactionId: string,
  userAgent = "Incoming test UA",
): { readonly request: http.ClientRequest; readonly response: Promise<RawResponse> } {
  let resolveResponse: ((result: RawResponse) => void) | undefined
  let rejectResponse: ((reason?: unknown) => void) | undefined
  const responsePromise = new Promise<RawResponse>((resolve, reject) => {
    resolveResponse = resolve
    rejectResponse = reject
  })
  const request = http.request(
    {
      hostname: "127.0.0.1",
      port: routerPort,
      path: pathname,
      method: "POST",
      agent: false,
      headers: {
        authorization: "Bearer test",
        "content-type": "application/json",
        "content-length": body.length,
        "x-interaction-id": interactionId,
        "user-agent": userAgent,
      },
    },
    (response) => {
      const chunks: Buffer[] = []
      response.on("data", (chunk) => chunks.push(chunk))
      response.on("end", () =>
        resolveResponse?.({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }),
      )
    },
  )
  request.setTimeout(3000, () => request.destroy(new Error(`Timed out requesting ${pathname}`)))
  request.on("error", (error) => rejectResponse?.(error))
  request.end(body)
  return { request, response: responsePromise }
}

function requiredValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message)
  return value
}

function requiredRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isJsonObject(value)) throw new Error(message)
  return value
}

function requiredArray(value: unknown, message: string): JsonArray {
  if (!isJsonArray(value)) throw new Error(message)
  return value
}

test("Given configured upstream providers, When the router handles compatible requests, Then routing, retrying, logging, and continuation storage remain correct", async () => {
  let proxy: ProxyService | null = null
  let upstreamStarted = false
  try {
    assert.strictEqual(isCapacityError("Selected model is at capacity. Please try a different model."), true)
    assert.strictEqual(isCapacityError("selected   model is at capacity please try a different model"), true)
    assert.strictEqual(isCapacityError("Selected model is unavailable. Please try a different model."), false)
    assert.strictEqual(shouldRetryUpstreamStatus(408), true)
    assert.strictEqual(shouldRetryUpstreamStatus(425), true)
    assert.strictEqual(shouldRetryUpstreamStatus(429), true)
    assert.strictEqual(shouldRetryUpstreamStatus(503), true)
    assert.strictEqual(shouldRetryUpstreamStatus(400), false)
    assert.strictEqual(shouldRetryUpstreamStatus(401), false)
    assert.strictEqual(shouldRetryUpstreamStatus(404), false)
    assert.doesNotThrow(
      () =>
        validateProvider(
          {
            id: "same-url-second",
            slug: "same-url-second",
            name: "Same URL second",
            baseUrl: "https://api.easytokens.org/v1",
            enabled: true,
            routeOnly: false,
          },
          [
            {
              id: "same-url-first",
              slug: "same-url-first",
              name: "Same URL first",
              baseUrl: "https://api.easytokens.org/v1",
              enabled: true,
              routeOnly: false,
            },
          ],
        ),
      "providers with the same upstream URL must remain valid when their route ids differ",
    )
    assert.throws(
      () =>
        validateProvider(
          {
            id: "credential-url",
            slug: "credential-url",
            name: "Credential URL",
            baseUrl: "https://user:password@example.com/v1",
            enabled: true,
            routeOnly: false,
          },
          [],
        ),
      /must not contain embedded credentials/,
    )
    assert.strictEqual(
      isAllowedDashboardMutation({ host: "llm-router.sky1218.com", origin: "https://llm-router.sky1218.com" }),
      true,
    )
    assert.strictEqual(
      isAllowedDashboardMutation({ host: "llm-router.sky1218.com", origin: "https://attacker.example" }),
      false,
    )
    assert.strictEqual(
      isAllowedDashboardMutation({
        host: "llm-router.sky1218.com",
        "x-forwarded-host": "attacker.example",
        origin: "https://attacker.example",
      }),
      false,
      "client forwarded host must not override the request host",
    )
    assert.strictEqual(
      isAllowedDashboardMutation({
        "x-forwarded-host": "llm-router.sky1218.com",
        origin: "https://llm-router.sky1218.com",
      }),
      false,
      "forwarded host must not authorize a request without Host",
    )
    await listen(upstream, upstreamPort)
    upstreamStarted = true
    const config: Mutable<RouterConfig> = {
      dashboardPort: 3122,
      routerPort,
      openBrowserOnLaunch: false,
      startRouterOnLaunch: false,
      forwardEnabled: true,
      transformEnabled: true,
      recordLogs: true,
      persistResponseContexts: true,
      clearLogsOnShutdown: false,
      retryCount: 0,
      capacityRetryCount: 2,
      retryDelayMs: 100,
      activeRequestTimeoutMs: 300000,
      dashboardAuth: { enabled: false, username: "", passwordHash: "" },
      codexProfile: {
        userAgent: "Configured test UA",
        originator: "Configured test originator",
        betaFeatures: "configured-beta",
        responsesLite: true,
        sendUserAgent: true,
        sendOriginator: true,
        sendBetaFeatures: true,
        sendResponsesLite: true,
      },
      providers: [
        {
          id: "local",
          slug: "local",
          name: "Local",
          baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
          enabled: true,
          routeOnly: false,
        },
        {
          id: "direct",
          slug: "direct",
          name: "Direct",
          baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
          enabled: true,
          routeOnly: true,
        },
      ],
    }
    const publicConfigView = publicConfig({
      ...config,
      dashboardAuth: { enabled: true, username: "dashboard-user", passwordHash: "private-hash" },
      providers: [
        {
          id: "credential-provider",
          slug: "credential-provider",
          name: "Credential Provider",
          baseUrl: "https://user:password@example.com/v1",
          enabled: true,
          routeOnly: false,
        },
      ],
    })
    assert.strictEqual(
      "passwordHash" in publicConfigView.dashboardAuth,
      false,
      "public config must not expose the dashboard password hash",
    )
    assert.strictEqual(
      publicConfigView.providers[0]?.baseUrl,
      "https://example.com/v1",
      "public config must redact embedded upstream credentials",
    )
    assert.strictEqual(
      publicConfigView.providers[0]?.enabled,
      true,
      "public config must preserve provider enabled state",
    )
    assert.strictEqual(
      publicConfigView.providers[0]?.routeOnly,
      false,
      "public config must preserve provider routing mode",
    )
    const publicMutationProvider = publicProvider({
      id: "public-provider",
      slug: "public-provider",
      name: "Public Provider",
      baseUrl: "https://user:password@example.com/v1",
      enabled: true,
      routeOnly: false,
    })
    assert.strictEqual(
      publicMutationProvider.baseUrl,
      "https://example.com/v1",
      "mutation responses must redact provider credentials",
    )
    assert.strictEqual(publicMutationProvider.enabled, true, "mutation responses must preserve provider enabled state")
    assert.strictEqual(
      publicMutationProvider.routeOnly,
      false,
      "mutation responses must preserve provider routing mode",
    )
    const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "router-test-"))
    fs.writeFileSync(
      path.join(dataDirectory, "request-logs.json"),
      JSON.stringify([
        {
          id: "legacy-log",
          createdAt: "2026-08-07T00:00:00.000Z",
          status: "success",
          path: "/legacy/v1/responses",
        },
      ]),
    )
    fs.writeFileSync(
      path.join(dataDirectory, "response-contexts.json"),
      JSON.stringify([
        {
          responseId: "legacy-response",
          sessionId: "legacy-session",
          sourceInteractionId: null,
          parentResponseId: null,
          imported: false,
          label: null,
          provider: null,
          logId: "legacy-log",
          createdAt: "2026-08-07T00:00:00.000Z",
          updatedAt: "2026-08-07T00:00:00.000Z",
          requestInput: [],
          responseOutput: [],
        },
      ]),
    )
    const legacyConfigPath = path.join(dataDirectory, "config.json")
    fs.writeFileSync(legacyConfigPath, JSON.stringify({ providers: [{ id: "before" }] }))
    const migrationDatabase = new RouterDatabase(dataDirectory)
    migrationDatabase.migrate("config-json-v1", () =>
      migrationDatabase.saveSetting("config", { providers: [{ id: "before" }] }),
    )
    fs.writeFileSync(legacyConfigPath, JSON.stringify({ providers: [{ id: "after" }] }))
    const laterLegacyTime = new Date(Date.now() + 1000)
    fs.utimesSync(legacyConfigPath, laterLegacyTime, laterLegacyTime)
    const syncResult = spawnSync(process.execPath, ["server/storage/legacy-sync.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, CODEX_ROUTER_DATA_DIR: dataDirectory },
    })
    assert.strictEqual(syncResult.status, 0, "legacy final sync should complete")
    const syncedConfig = objectFromUnknown(migrationDatabase.setting("config"))
    const syncedProviders = Array.isArray(syncedConfig.providers) ? syncedConfig.providers : []
    assert.strictEqual(
      objectFromUnknown(syncedProviders[0]).id,
      "after",
      "legacy final sync should preserve the last config write before cutover",
    )
    migrationDatabase.saveSetting("config", { providers: [{ id: "target" }] })
    const earlierLegacyTime = new Date(Date.now() - 1000)
    fs.utimesSync(legacyConfigPath, earlierLegacyTime, earlierLegacyTime)
    const secondSyncResult = spawnSync(process.execPath, ["server/storage/legacy-sync.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, CODEX_ROUTER_DATA_DIR: dataDirectory },
    })
    assert.strictEqual(secondSyncResult.status, 0, "a second legacy final sync should complete")
    const targetConfig = objectFromUnknown(migrationDatabase.setting("config"))
    const targetProviders = Array.isArray(targetConfig.providers) ? targetConfig.providers : []
    assert.strictEqual(
      objectFromUnknown(targetProviders[0]).id,
      "target",
      "legacy final sync should not overwrite a newer target config",
    )
    const newerContext = {
      responseId: "context-timestamp-precedence",
      sessionId: "newer-session",
      updatedAt: "2026-08-07T00:00:02.000Z",
    }
    migrationDatabase.saveContext(
      newerContext.responseId,
      newerContext.updatedAt,
      newerContext.sessionId,
      null,
      newerContext,
    )
    migrationDatabase.saveContext(newerContext.responseId, "2026-08-07T00:00:01.000Z", "older-session", null, {
      ...newerContext,
      sessionId: "older-session",
      updatedAt: "2026-08-07T00:00:01.000Z",
    })
    assert.strictEqual(
      objectFromUnknown(migrationDatabase.context(newerContext.responseId)).sessionId,
      "newer-session",
      "an older legacy context should not overwrite a newer target context",
    )
    migrationDatabase.saveContext(newerContext.responseId, "2026-08-07T00:00:03.000Z", "newest-session", null, {
      ...newerContext,
      sessionId: "newest-session",
      updatedAt: "2026-08-07T00:00:03.000Z",
    })
    assert.strictEqual(
      objectFromUnknown(migrationDatabase.context(newerContext.responseId)).sessionId,
      "newest-session",
      "a newer context should replace an older target context",
    )
    assert.strictEqual(
      fs.statSync(dataDirectory).mode & 0o777,
      0o700,
      "the data directory should only be accessible by its owner",
    )
    assert.strictEqual(
      fs.statSync(path.join(dataDirectory, "router.sqlite")).mode & 0o777,
      0o600,
      "the SQLite database should only be accessible by its owner",
    )
    for (const fileName of ["config.json", "request-logs.json", "response-contexts.json"]) {
      assert.strictEqual(
        fs.statSync(path.join(dataDirectory, fileName)).mode & 0o777,
        0o600,
        `${fileName} should only be accessible by its owner`,
      )
    }
    const store = new RequestLogStore(dataDirectory, () => true)
    const contexts = new ResponseContextStore(dataDirectory, () => true)
    assert.strictEqual(
      store.get("legacy-log")?.path,
      "/legacy/v1/responses",
      "legacy JSON logs should be imported into SQLite",
    )
    assert.strictEqual(
      contexts.get("legacy-response")?.sessionId,
      "legacy-session",
      "legacy JSON contexts should be imported into SQLite",
    )
    const secondStore = new RequestLogStore(dataDirectory, () => true)
    const firstLogId = requiredValue(store.create({ path: "/first-process" }), "first process log id should exist")
    assert.strictEqual(
      secondStore.get(firstLogId)?.path,
      "/first-process",
      "a second process should read logs written by the first process",
    )
    const secondLogId = requiredValue(
      secondStore.create({ path: "/second-process" }),
      "second process log id should exist",
    )
    assert.strictEqual(
      store.get(secondLogId)?.path,
      "/second-process",
      "the first process should read logs written by the second process",
    )
    store.clear()
    const secondContexts = new ResponseContextStore(dataDirectory, () => true)
    contexts.save("resp_first_process", [], [], { sessionId: "shared-storage-test" })
    assert(
      secondContexts.get("resp_first_process"),
      "a second process should read contexts written by the first process",
    )
    secondContexts.save("resp_second_process", [], [], { sessionId: "shared-storage-test" })
    assert(contexts.get("resp_second_process"), "the first process should read contexts written by the second process")
    contexts.clear()
    proxy = new ProxyService(() => config, store, contexts)
    await proxy.start()
    const health = await getRaw("/healthz")
    assert.strictEqual(health.statusCode, 200, "router health endpoint should be available without a provider route")
    assert.strictEqual(
      objectFromUnknown(JSON.parse(health.body)).activeRequests,
      0,
      "router health should report active request count",
    )
    await post("/local/v1/responses", {
      model: "test",
      input: [
        { type: "message", role: "system", content: [{ type: "input_text", text: "rules" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "use tool" }] },
      ],
      tools: [{ type: "function", name: "list_dir", parameters: { type: "object" } }],
      stream: true,
    })
    const convertedChatBody = Buffer.from(
      '{"model":"chat-model","messages":[{"role":"user","content":"hello"}],"stream":true}',
    )
    const convertedChatStatus = await postRaw(
      "/local/v1/chat/completions",
      convertedChatBody,
      "Bearer test",
      "converted-chat",
    )
    assert.strictEqual(convertedChatStatus, 200, "chat completions should reach upstream when conversion is enabled")
    assert.strictEqual(requiredValue(seen.at(-1), "converted chat request should exist").url, "/v1/chat/completions")
    assert.strictEqual(
      requiredValue(seen.at(-1), "converted chat request should exist").rawBody.toString(),
      convertedChatBody.toString(),
    )
    assert.strictEqual(
      requiredValue(seen.at(-1), "converted chat request should exist").headers["user-agent"],
      "Configured test UA",
    )
    assert.strictEqual(
      requiredValue(seen.at(-1), "converted chat request should exist").headers.originator,
      "Configured test originator",
    )
    const reloadedContexts = new ResponseContextStore(dataDirectory, () => true)
    assert(reloadedContexts.get("resp_test"), "response context should be available after a store reload")
    const firstHistory = requiredArray(
      reloadedContexts.getHistory("resp_test"),
      "response context history should be available",
    )
    reloadedContexts.save(
      "resp_delta",
      [...firstHistory, { type: "message", role: "user", content: [{ type: "input_text", text: "next turn" }] }],
      [],
      { sessionId: "test-session", parentResponseId: "resp_test" },
    )
    assert.strictEqual(
      requiredValue(reloadedContexts.get("resp_delta"), "delta context should exist").requestInput.length,
      1,
      "child contexts should only store their input delta",
    )
    assert.strictEqual(
      requiredArray(reloadedContexts.getHistory("resp_delta"), "delta history should exist").length,
      firstHistory.length + 1,
    )
    const transcriptPath = path.join(dataDirectory, "copilot-session.jsonl")
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify({ type: "session.start", data: { sessionId: "copilot-session" } })}\n${JSON.stringify({ type: "user.message", data: { content: "restore this session" } })}\n${JSON.stringify({ type: "assistant.message", data: { content: "I will restore it.", toolRequests: [{ toolCallId: "call_imported", name: "list_dir", arguments: "{}" }] } })}\n`,
      "utf8",
    )
    const imported = importCopilotTranscript(transcriptPath, "resp_imported", reloadedContexts)
    assert.strictEqual(imported.transcriptSessionId, "copilot-session")
    assert(reloadedContexts.get("resp_imported"), "transcript import should create a response context")
    resetResponseContexts()
    const recovered = transformToCodex(
      { "x-interaction-id": "new-interaction-id" },
      Buffer.from(
        JSON.stringify({
          model: "test",
          previous_response_id: "resp_test",
          input: [{ type: "function_call_output", call_id: "call_test", output: "file.txt" }],
        }),
      ),
      "/responses",
      config.codexProfile,
      reloadedContexts,
    )
    assert.strictEqual(
      requiredValue(recovered.trace.continuation, "continuation trace should be available").outcome,
      "restored",
    )
    assert.strictEqual(recovered.headers["session-id"], "test-session")
    assert.strictEqual(recovered.headers["user-agent"], "Configured test UA")
    assert.strictEqual(recovered.headers.originator, "Configured test originator")
    assert.strictEqual(recovered.headers["x-codex-beta-features"], "configured-beta")
    assert.strictEqual(recovered.headers["x-openai-internal-codex-responses-lite"], "true")
    assert.strictEqual(recovered.request.prompt_cache_key, "test-session")
    assert(
      requiredArray(recovered.request.input, "transformed input should be an array").some(
        (item) => objectFromUnknown(item).type === "function_call" && objectFromUnknown(item).call_id === "call_test",
      ),
    )
    await post("/local/v1/responses", {
      model: "test",
      previous_response_id: "resp_test",
      input: [{ type: "function_call_output", call_id: "call_test", output: "file.txt" }],
      stream: true,
    })
    const missingContextStatus = await post("/local/v1/responses", {
      model: "test",
      previous_response_id: "resp_missing",
      input: [
        { type: "function_call_output", call_id: "call_missing", output: "stale result" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "continue safely" }] },
      ],
      stream: true,
    })
    assert.strictEqual(missingContextStatus, 401)
    const orphanStatus = await post("/local/v1/responses", {
      model: "test",
      previous_response_id: "resp_missing_again",
      input: [{ type: "function_call_output", call_id: "call_missing_again", output: "stale result" }],
      stream: true,
    })
    assert.strictEqual(orphanStatus, 401)
    const missingContextLog = requiredValue(
      store.logs.find((log) => log.errorCode === "missing_continuation_context"),
      "missing continuation log should exist",
    )
    assert.strictEqual(missingContextLog.errorOrigin, "local")
    assert.strictEqual(missingContextLog.response, undefined)
    assert.strictEqual(seen.length, 3, "missing continuation requests must never reach upstream")
    const firstSeen = requiredValue(seen[0], "first upstream request should exist")
    const secondSeen = requiredValue(seen[2], "second upstream request should exist")
    const firstBody = requiredRecord(firstSeen.body, "first upstream request should have a JSON body")
    const secondBody = requiredRecord(secondSeen.body, "second upstream request should have a JSON body")
    assert.strictEqual(firstSeen.url, "/v1/responses")
    assert.strictEqual(firstSeen.headers["x-openai-internal-codex-responses-lite"], "true")
    assert.strictEqual(
      objectFromUnknown(requiredArray(firstBody.input, "first request input should be an array")[0]).type,
      "additional_tools",
    )
    assert.strictEqual(
      objectFromUnknown(requiredArray(firstBody.input, "first request input should be an array")[1]).role,
      "developer",
    )
    assert.strictEqual(firstBody.store, false)
    assert.strictEqual(secondBody.previous_response_id, undefined)
    assert(
      requiredArray(secondBody.input, "second request input should be an array").some(
        (item) => objectFromUnknown(item).type === "function_call" && objectFromUnknown(item).call_id === "call_test",
      ),
    )
    assert(
      requiredArray(secondBody.input, "second request input should be an array").some(
        (item) =>
          objectFromUnknown(item).type === "function_call_output" && objectFromUnknown(item).call_id === "call_test",
      ),
    )
    const selectiveHeaders = applyCodexProfileHeaders(
      {
        "user-agent": "Incoming UA",
        originator: "Incoming originator",
        "x-codex-beta-features": "Incoming beta",
        "x-openai-internal-codex-responses-lite": "true",
        authorization: "Bearer test",
      },
      {
        ...config.codexProfile,
        sendUserAgent: false,
        sendOriginator: true,
        sendBetaFeatures: false,
        sendResponsesLite: false,
      },
    )
    assert.strictEqual(selectiveHeaders["user-agent"], undefined, "disabled User-Agent must not leak an incoming value")
    assert.strictEqual(selectiveHeaders.originator, "Configured test originator")
    assert.strictEqual(
      selectiveHeaders["x-codex-beta-features"],
      undefined,
      "disabled beta header must not leak an incoming value",
    )
    assert.strictEqual(
      selectiveHeaders["x-openai-internal-codex-responses-lite"],
      undefined,
      "disabled Responses Lite header must not leak an incoming value",
    )
    assert.strictEqual(selectiveHeaders.authorization, "Bearer test")
    assert.strictEqual(
      requiredValue(
        store.logs.find((log) => log.responseContext?.responseId === "resp_test"),
        "response context log should exist",
      ).target,
      `http://127.0.0.1:${upstreamPort}/v1/responses`,
    )
    const completedResponseHeaders = objectFromUnknown(
      requiredValue(
        requiredValue(
          store.logs.find((log) => log.responseContext?.responseId === "resp_test"),
          "response context log should exist",
        ).response,
        "response log should exist",
      ).headers,
    )
    assert.strictEqual(
      completedResponseHeaders["set-cookie"],
      "[REDACTED]",
      "stored response headers must redact upstream cookies",
    )
    const invalidTokenStatus = await post(
      "/local/v1/responses",
      {
        model: "test",
        previous_response_id: "resp_test",
        input: [{ type: "function_call_output", call_id: "call_test", output: "file.txt" }],
        stream: true,
      },
      "Bearer invalid",
    )
    assert.strictEqual(invalidTokenStatus, 401)
    const invalidTokenLog = requiredValue(
      store.logs.find((log) => log.error === "Invalid token"),
      "invalid token log should exist",
    )
    assert.strictEqual(invalidTokenLog.errorOrigin, "upstream")
    assert.strictEqual(invalidTokenLog.errorCode, "invalid_api_key")
    assert.strictEqual(
      requiredValue(invalidTokenLog.transform, "invalid token log should have a trace").continuation?.outcome,
      "restored",
    )

    const slowBody = Buffer.from(
      JSON.stringify({
        model: "slow-model",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "keep this stream open" }] }],
        stream: true,
      }),
    )
    const concurrentRequests = [
      postRaw("/local/v1/slow-responses", slowBody, "Bearer test", "session-one"),
      postRaw("/local/v1/slow-responses", slowBody, "Bearer test", "session-two"),
      postRaw("/direct/v1/slow-route-only", slowBody, "Bearer test", "session-three"),
    ]
    await slowHeadersReady
    const waitingRequests = proxy.status().activeRequests
    assert.strictEqual(
      waitingRequests.length,
      3,
      "all concurrent requests should remain active while waiting for first response",
    )
    assert.strictEqual(
      new Set(waitingRequests.map((request) => request.id)).size,
      3,
      "concurrent requests should have independent ids",
    )
    assert.strictEqual(
      waitingRequests.filter((request) => request.routeOnly).length,
      1,
      "route-only requests should be tracked alongside converted requests",
    )
    const activeProxy = requiredValue(proxy, "active proxy should exist while requests are in flight")
    assert.doesNotThrow(() => JSON.stringify(activeProxy.status()), "active router status must be JSON serializable")
    await new Promise((resolve) => setTimeout(resolve, 55))
    const streamingRequests = proxy.status().activeRequests
    assert.strictEqual(streamingRequests.length, 3, "all concurrent requests should remain active while streaming")
    assert(
      streamingRequests.every((request) => request.status === "streaming"),
      "each concurrent request should transition to streaming independently",
    )
    await slowBodiesReady
    await Promise.all(concurrentRequests)
    assert.strictEqual(
      proxy.status().activeRequests.length,
      0,
      "completed concurrent requests should be removed from active state",
    )

    const cancelBody = Buffer.from(
      JSON.stringify({
        model: "cancel-model",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "cancel me" }] }],
        stream: true,
      }),
    )
    const beforeResponse = startRaw("/local/v1/cancel-before", cancelBody, "cancel-before")
    const beforeRequest = await waitForActive(proxy, (request: ActiveRequest) => request.sessionId === "cancel-before")
    assert.deepStrictEqual(proxy.cancelActiveRequest(beforeRequest.id), { found: true, cancelled: true })
    const beforeResult = await beforeResponse.response
    assert.strictEqual(beforeResult.statusCode, 499, "cancelling before first response should return HTTP 499")
    assert(
      beforeResult.body.includes("request_cancelled"),
      "pre-response cancellation should return the cancellation error code",
    )

    const streamResponse = startRaw("/direct/v1/cancel-stream", cancelBody, "cancel-stream")
    const streamRequest = await waitForActive(
      proxy,
      (request: ActiveRequest) => request.sessionId === "cancel-stream" && request.status === "streaming",
    )
    assert.deepStrictEqual(proxy.cancelActiveRequest(streamRequest.id), { found: true, cancelled: true })
    const streamResult = await streamResponse.response
    assert.strictEqual(
      streamResult.statusCode,
      200,
      "a stream that already sent headers keeps its original HTTP status",
    )
    assert(streamResult.body.includes("request_cancelled"), "stream cancellation should send an SSE cancellation error")
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.strictEqual(
      proxy.status().activeRequests.length,
      0,
      "cancelled requests should be removed after their connections close",
    )

    const previousTimeout = config.activeRequestTimeoutMs
    config.activeRequestTimeoutMs = 60
    const timeoutBody = Buffer.from(
      JSON.stringify({
        model: "timeout-model",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "wait forever" }] }],
        stream: true,
      }),
    )
    const timeoutResponse = startRaw("/local/v1/hang", timeoutBody, "timeout-session")
    const timeoutResult = await timeoutResponse.response
    assert.strictEqual(timeoutResult.statusCode, 504, "hanging requests should time out with HTTP 504")
    assert(timeoutResult.body.includes("request_timeout"), "timed out requests should return the timeout error code")
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.strictEqual(
      proxy.status().activeRequests.length,
      0,
      "timed out requests should be removed from active state",
    )
    config.activeRequestTimeoutMs = previousTimeout

    config.retryCount = 1
    config.retryDelayMs = 0
    const retriedStream = await startRaw(
      "/local/v1/disconnect-before-data",
      Buffer.from('{"model":"retry-model","input":[],"stream":true}'),
      "retry-before-data",
    ).response
    assert.strictEqual(retriedStream.statusCode, 200)
    assert.strictEqual(disconnectBeforeDataAttempts, 2, "a disconnect before the first body chunk should retry")
    assert(retriedStream.body.includes("resp_retried"), "the client should receive the successful retry stream")

    const routeOnlyLogCount = store.logs.length
    const routeOnlyContextCount = contexts.contexts.length
    config.forwardEnabled = false
    config.retryCount = 2
    config.retryDelayMs = 50
    const chatBody = Buffer.from('{"model":"chat-model","messages":[{"role":"user","content":"hello"}],"stream":false}')
    const chatStart = Date.now()
    const chatResponse = startRaw("/direct/v1/chat/completions", chatBody, "single-retrying-client")
    await waitForActive(
      proxy,
      (request: ActiveRequest) => request.sessionId === "single-retrying-client" && request.failedAttempts === 1,
    )
    assert.strictEqual(
      proxy.status().activeRequests.filter((request: ActiveRequest) => request.sessionId === "single-retrying-client")
        .length,
      1,
      "upstream retries for one client request must reuse one active request entry",
    )
    const chatResult = await chatResponse.response
    const chatElapsed = Date.now() - chatStart
    assert.strictEqual(chatResult.statusCode, 200)
    assert.strictEqual(routeOnlyAttempts, 3, "route-only requests should retry failed upstream responses")
    assert(chatElapsed >= 100, "route-only retries should wait for the configured interval")
    const latestSeen = requiredValue(seen.at(-1), "chat upstream request should exist")
    assert.strictEqual(latestSeen.url, "/v1/chat/completions")
    assert.strictEqual(latestSeen.headers.host, `127.0.0.1:${upstreamPort}`)
    assert.strictEqual(
      latestSeen.headers["user-agent"],
      "Incoming test UA",
      "route-only requests must preserve the incoming User-Agent",
    )
    assert.strictEqual(
      latestSeen.rawBody.toString(),
      chatBody.toString(),
      "route-only body must be forwarded byte-for-byte",
    )
    assert.strictEqual(
      requiredValue(seen.at(-2), "chat retry request should exist").rawBody.toString(),
      chatBody.toString(),
    )
    assert.strictEqual(
      requiredValue(seen.at(-3), "initial chat request should exist").rawBody.toString(),
      chatBody.toString(),
    )
    assert.strictEqual(store.logs.length, routeOnlyLogCount + 1, "route-only requests should create a dashboard log")
    const chatLog = requiredValue(store.logs[0], "route-only request log should exist")
    assert.strictEqual(chatLog.path, "/direct/v1/chat/completions")
    assert.strictEqual(chatLog.status, "completed")
    assert.strictEqual(chatLog.responseStatus, 200)
    assert.strictEqual(chatLog.sessionId, "single-retrying-client")
    assert.strictEqual(
      objectFromUnknown(requiredValue(chatLog.inbound, "route-only log should contain inbound data").headers)
        .authorization,
      "[REDACTED]",
    )
    assert.strictEqual(
      objectFromUnknown(requiredValue(chatLog.outbound, "route-only log should contain outbound data").headers)
        .authorization,
      "[REDACTED]",
    )
    assert.strictEqual(
      contexts.contexts.length,
      routeOnlyContextCount,
      "route-only requests must not create local contexts",
    )

    config.retryCount = 0
    config.capacityRetryCount = 2
    const capacityStatus = await postRaw("/direct/v1/capacity", chatBody)
    assert.strictEqual(capacityStatus, 200, "capacity responses should retry until the upstream recovers")
    assert.strictEqual(capacityAttempts, 3, "capacity responses should use the bounded capacity retry policy")
    config.retryCount = 5
    config.capacityRetryCount = 1
    const persistentCapacityStatus = await postRaw("/direct/v1/capacity-always", chatBody)
    assert.strictEqual(
      persistentCapacityStatus,
      503,
      "persistent capacity errors should return the final upstream error",
    )
    assert.strictEqual(persistentCapacityAttempts, 2, "capacity retries must use the dedicated setting")
    await waitForNoActive(proxy, (request: ActiveRequest) => request.path === "/direct/v1/capacity-always")

    config.retryCount = 0
    const responsesBody = Buffer.from(
      '{"model":"responses-model","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}]}',
    )
    const responsesStatus = await postRaw("/direct/v1/responses-route-only", responsesBody)
    assert.strictEqual(responsesStatus, 200)
    assert.strictEqual(
      requiredValue(seen.at(-1), "route-only responses request should exist").url,
      "/v1/responses-route-only",
    )
    assert.strictEqual(
      requiredValue(seen.at(-1), "route-only responses request should exist").rawBody.toString(),
      responsesBody.toString(),
      "route-only responses body must remain unchanged",
    )
    assert.strictEqual(
      store.logs.length,
      routeOnlyLogCount + 4,
      "responses route-only requests should create a dashboard log",
    )
    assert.strictEqual(
      contexts.contexts.length,
      routeOnlyContextCount,
      "responses route-only requests must not create local contexts",
    )

    const logsBeforeRecordingDisabled = store.logs.length
    const contextsBeforeRecordingDisabled = contexts.contexts.length
    store.setRecording(false)
    config.forwardEnabled = true
    const recordingDisabledStatus = await post("/local/v1/no-log-context", {
      model: "private-model",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "do not save this" }] }],
      stream: true,
    })
    assert.strictEqual(recordingDisabledStatus, 200)
    assert.strictEqual(
      store.logs.length,
      logsBeforeRecordingDisabled,
      "requests must not create logs when detailed logging is disabled",
    )
    assert.strictEqual(
      contexts.contexts.length,
      contextsBeforeRecordingDisabled,
      "requests must not create response contexts when detailed logging is disabled",
    )
  } finally {
    await proxy?.stop()
    if (upstreamStarted) await close(upstream)
  }
})

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve))
}
function close(server: http.Server): Promise<void> {
  return new Promise<void>((resolve) => server.close(() => resolve()))
}
async function waitForActive(
  proxy: ProxyService,
  predicate: (request: ActiveRequest) => boolean,
): Promise<ActiveRequest> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const request = proxy.status().activeRequests.find(predicate)
    if (request) return request
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("Timed out waiting for active request state.")
}

async function waitForNoActive(proxy: ProxyService, predicate: (request: ActiveRequest) => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!proxy.status().activeRequests.some(predicate)) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("Timed out waiting for active request cleanup.")
}
