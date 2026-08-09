import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import type { RouterConfig } from "../core/types"
import { ProxyService } from "../router/proxy-service"
import { RequestLogStore } from "../storage/request-log"
import { ResponseContextStore } from "../storage/response-context"

test("Given an in-flight request, When the router stops, Then the request is cancelled and no active entry remains", async () => {
  const upstream = http.createServer(() => undefined)
  await listen(upstream)
  const upstreamAddress = serverAddress(upstream)
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "router-stop-"))
  const config = routerConfig(`http://127.0.0.1:${upstreamAddress.port}`)
  const logs = new RequestLogStore(dataDirectory, () => config.recordLogs)
  const contexts = new ResponseContextStore(dataDirectory, () => config.persistResponseContexts)
  const proxy = new ProxyService(() => config, logs, contexts)
  await proxy.start()
  const proxyAddress = serverAddress(proxy.server)
  const created = onceEvent(proxy, "changed")
  const response = request(`http://127.0.0.1:${proxyAddress.port}/test/v1/responses`)

  await created
  await proxy.stop()

  expect(proxy.status().activeRequests).toEqual([])
  expect((await response).statusCode).toBe(499)
  await close(upstream)
})

function routerConfig(baseUrl: string): RouterConfig {
  return {
    dashboardPort: 0,
    routerPort: 0,
    openBrowserOnLaunch: false,
    startRouterOnLaunch: false,
    forwardEnabled: true,
    transformEnabled: false,
    recordLogs: false,
    persistResponseContexts: false,
    clearLogsOnShutdown: false,
    retryCount: 0,
    capacityRetryCount: 0,
    retryDelayMs: 100,
    activeRequestTimeoutMs: 10_000,
    dashboardAuth: { enabled: false, username: "", passwordHash: "" },
    codexProfile: {
      userAgent: "",
      originator: "",
      betaFeatures: "",
      responsesLite: false,
      sendUserAgent: false,
      sendOriginator: false,
      sendBetaFeatures: false,
      sendResponsesLite: false,
    },
    providers: [{ id: "test", slug: "test", name: "Test", baseUrl, enabled: true, routeOnly: true }],
  }
}

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

function serverAddress(server: http.Server | null): { readonly port: number } {
  const address = server?.address()
  if (!address || typeof address === "string") throw new Error("Expected a listening TCP server.")
  return address
}

function onceEvent(emitter: NodeJS.EventEmitter, eventName: string): Promise<void> {
  return new Promise((resolve) => emitter.once(eventName, () => resolve()))
}

function request(url: string): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const client = http.get(url, resolve)
    client.once("error", reject)
  })
}
