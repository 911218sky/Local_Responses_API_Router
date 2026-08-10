import { EventEmitter } from "node:events"
import * as http from "node:http"
import * as https from "node:https"
import * as net from "node:net"
import type { Duplex } from "node:stream"
import * as tls from "node:tls"
import { URL } from "node:url"
import {
  errorMessage,
  type Headers,
  isJsonArray,
  isJsonObject,
  type JsonArray,
  type JsonObject,
  type Provider,
  type ResponseContextMetadata,
  type RouterConfig,
  type TransformTrace,
} from "../core/types"
import type { RequestLogStore } from "../storage/request-log"
import type { ResponseContextStore } from "../storage/response-context"
import { type ActiveRequest, ActiveRequestTracker, type PublicActiveRequest } from "./active-request-tracker"
import {
  delay,
  errorCode,
  errorStatus,
  getUpstreamError,
  headerValue,
  isCapacityError,
  isResponsesPath,
  publicProvider,
  readResponseBody,
  redactHeaders,
  resolveSessionId,
  sendJson,
  tryJson,
  usageFrom,
} from "./http-utils"
import { createResponseContextObserver, type ResponseContextObserver } from "./response-context-observer"
import { applyCodexProfileHeaders, transformToCodex } from "./transformer"

interface Route {
  readonly provider: Provider
  readonly upstreamPath: string
}

interface OutboundRequest {
  readonly headers: Headers
  readonly bodyBuffer: Buffer
  readonly method: string
  readonly path: string
  readonly body?: JsonObject
  readonly sessionId?: string
  readonly sourceInteractionId?: string
  readonly previousResponseId?: string | null
}

interface RouterStatus {
  readonly running: boolean
  readonly port: number
  readonly startedAt: string | null
  readonly routeFormat: string
  readonly activeRequests: PublicActiveRequest[]
}

class ProxyService extends EventEmitter {
  readonly getConfig: () => RouterConfig
  readonly logStore: RequestLogStore
  readonly contextStore: ResponseContextStore
  server: http.Server | null
  startedAt: string | null
  private startPromise: Promise<RouterStatus> | null
  // Retries update one entry so the dashboard never double-counts a client request.
  readonly activeRequests: ActiveRequestTracker

  constructor(getConfig: () => RouterConfig, logStore: RequestLogStore, contextStore: ResponseContextStore) {
    super()
    this.getConfig = getConfig
    this.logStore = logStore
    this.contextStore = contextStore
    this.server = null
    this.startedAt = null
    this.startPromise = null
    this.activeRequests = new ActiveRequestTracker({
      timeoutMs: () => this.getConfig().activeRequestTimeoutMs,
      logStore: this.logStore,
      notify: (event) => this.emit("changed", event),
    })
  }

  start(): Promise<RouterStatus> {
    if (this.startedAt && this.server) return Promise.resolve(this.status())
    if (this.startPromise) return this.startPromise
    const { routerPort } = this.getConfig()
    const server = http.createServer((req, res) => this.handleHttp(req, res))
    this.server = server
    server.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head))
    let settled = false
    const promise = new Promise<RouterStatus>((resolve, reject) => {
      const fail = (error: unknown): void => {
        if (settled) {
          console.error(`Router server error: ${errorMessage(error)}`)
          return
        }
        settled = true
        if (this.server === server) {
          this.server = null
          this.startedAt = null
        }
        if (server.listening) server.close()
        this.startPromise = null
        reject(error)
      }
      server.on("error", fail)
      server.listen(routerPort, process.env.CODEX_ROUTER_LISTEN_HOST || "127.0.0.1", () => {
        if (settled) return
        settled = true
        if (this.server !== server) {
          this.startPromise = null
          resolve(this.status())
          return
        }
        this.startedAt = new Date().toISOString()
        this.startPromise = null
        console.log(`Router service listening on http://127.0.0.1:${routerPort}/<provider>/v1`)
        const status = this.status()
        this.emit("changed", { type: "router-started", status })
        resolve(status)
      })
    })
    this.startPromise = promise
    return promise
  }

  async stop(): Promise<RouterStatus> {
    const starting = this.startPromise
    const server = this.server
    if (!server) {
      await starting?.catch(() => undefined)
      return this.status()
    }
    this.server = null
    this.startedAt = null
    this.activeRequests.cancelAll()
    await starting?.catch(() => undefined)
    if (server.listening) await closeServer(server)
    const status = this.status()
    this.emit("changed", { type: "router-stopped", status })
    return status
  }

  status(): RouterStatus {
    const config = this.getConfig()
    return {
      running: Boolean(this.server && this.startedAt),
      port: config.routerPort,
      startedAt: this.startedAt,
      routeFormat: `http://127.0.0.1:${config.routerPort}/{provider}/v1/responses`,
      activeRequests: this.activeRequests.list(),
    }
  }

  cancelActiveRequest(id: string): { readonly found: boolean; readonly cancelled?: boolean } {
    return this.activeRequests.cancel(id)
  }

  async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method === "GET" && req.url === "/healthz") {
      return sendJson(res, 200, {
        status: "ok",
        activeRequests: this.activeRequests.size,
      })
    }
    const route = resolveRoute(req.url, this.getConfig().providers)
    if (!route)
      return sendJson(res, 404, { error: "Use /{provider}/v1/... and configure that provider in the dashboard." })
    if (!route.provider.enabled) return sendJson(res, 503, { error: `Provider "${route.provider.slug}" is disabled.` })
    const activeRequest = this.activeRequests.begin({
      provider: publicProvider(route.provider),
      routeOnly: route.provider.routeOnly === true,
      method: req.method || "GET",
      path: req.url || "/",
      sessionId: resolveSessionId(req.headers, route.provider),
    })
    this.activeRequests.watchClientResponse(res, activeRequest.id)

    const chunks: Buffer[] = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("error", (error) => {
      this.activeRequests.finish(activeRequest.id)
      this.fail(res, null, error)
    })
    req.on("end", async () => {
      const rawBody = Buffer.concat(chunks)
      const config = this.getConfig()
      const started = Date.now()
      const routeOnly = route.provider.routeOnly === true
      let outbound: OutboundRequest = routeOnly
        ? { headers: { ...req.headers }, bodyBuffer: rawBody, method: req.method || "GET", path: route.upstreamPath }
        : {
            headers: { ...req.headers },
            body: jsonObjectFrom(tryJson(rawBody)),
            bodyBuffer: rawBody,
            method: req.method || "GET",
            path: route.upstreamPath,
          }
      let transform: TransformTrace | null = routeOnly
        ? null
        : {
            mode: "passthrough",
            operations: [
              {
                type: "passed",
                scope: "routing",
                from: req.url || "/",
                to: route.upstreamPath,
                label: `Selected provider ${route.provider.slug} and removed its local route prefix`,
              },
              {
                type: "passed",
                scope: "body",
                from: "request",
                to: "request",
                label: "Codex conversion disabled",
              },
            ],
          }
      const sessionId = resolveSessionId(req.headers, route.provider)
      const logId = this.logStore.create({
        provider: publicProvider(route.provider),
        method: req.method || "GET",
        path: req.url || "/",
        localUrl: `http://127.0.0.1:${config.routerPort}${req.url || "/"}`,
        sessionId,
        inbound: { headers: redactHeaders(req.headers), body: tryJson(rawBody), bytes: rawBody.length },
        ...(transform ? { transform } : {}),
        outbound: logOutbound(outbound),
      })
      activeRequest.logId = logId

      try {
        if (!routeOnly && !config.forwardEnabled) throw new HttpError(503, "Forwarding is disabled in the dashboard.")
        if (!routeOnly && config.transformEnabled && isResponsesPath(route.upstreamPath)) {
          const transformed = transformToCodex(
            req.headers,
            rawBody,
            route.upstreamPath,
            config.codexProfile,
            this.contextStore,
          )
          outbound = {
            headers: transformed.headers,
            body: transformed.request,
            bodyBuffer: transformed.body,
            method: transformed.method,
            path: transformed.path,
            sessionId: transformed.sessionId,
            sourceInteractionId: transformed.sourceInteractionId,
            previousResponseId: transformed.previousResponseId,
          }
          transform = transformed.trace
          transform.operations.unshift({
            type: "transformed",
            scope: "routing",
            from: req.url || "/",
            to: route.upstreamPath,
            label: `Matched provider ${route.provider.slug}; removed /${route.provider.slug}/v1 before assembling upstream path`,
          })
          this.logStore.update(logId, {
            transform,
            outbound: logOutbound(outbound),
            sessionId: transformed.sessionId,
            sourceInteractionId: transformed.sourceInteractionId,
          })
        } else if (!routeOnly && config.transformEnabled) {
          outbound = { ...outbound, headers: applyCodexProfileHeaders(outbound.headers, config.codexProfile) }
          transform?.operations.push({
            type: "transformed",
            scope: "headers",
            from: "request headers",
            to: "upstream headers",
            label: "Applied configured Codex request identity headers without changing the request body",
          })
          this.logStore.update(logId, { ...(transform ? { transform } : {}), outbound: logOutbound(outbound) })
        }
        this.activeRequests.update(activeRequest.id, {
          sessionId: outbound.sessionId || headerValue(outbound.headers["session-id"]) || activeRequest.sessionId,
          sourceInteractionId: outbound.sourceInteractionId || null,
        })
        await this.forward(route.provider, outbound, res, logId, started, config, routeOnly, activeRequest.id)
      } catch (error) {
        this.activeRequests.finish(activeRequest.id)
        if (error instanceof RequestCancelledError) return
        this.fail(res, logId, error, Date.now() - started)
      }
    })
  }

  async forward(
    provider: Provider,
    outbound: OutboundRequest,
    clientRes: http.ServerResponse,
    logId: string | null,
    started: number,
    config: RouterConfig,
    routeOnly = false,
    activeId: string | null = null,
  ): Promise<void> {
    const targetUrl = new URL(provider.baseUrl)
    const basePath = targetUrl.pathname.endsWith("/") ? targetUrl.pathname.slice(0, -1) : targetUrl.pathname
    const finalPath = `${basePath}${outbound.path}`
    const protocol = targetUrl.protocol === "https:" ? https : http
    const headers: Headers = { ...outbound.headers, host: targetUrl.host }
    const options: http.RequestOptions = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
      path: finalPath,
      method: outbound.method,
      headers,
    }
    const body = outbound.bodyBuffer
    let lastError: unknown

    for (let attempt = 0; ; attempt += 1) {
      const active = activeId ? this.activeRequests.get(activeId) : undefined
      if (active?.cancelled) throw new RequestCancelledError()
      this.activeRequests.update(activeId, {
        attempt: attempt + 1,
        status: (active?.failedAttempts || 0) > 0 ? "retry_waiting_first_response" : "waiting_first_response",
      })
      try {
        const upstream = await makeRequest(protocol, options, body, active)
        const current = activeId ? this.activeRequests.get(activeId) : undefined
        if (current) current.upstreamResponse = upstream
        if (current?.cancelled) {
          upstream.destroy()
          throw new RequestCancelledError()
        }
        const statusCode = upstream.statusCode || 502
        const failed = shouldRetryUpstreamStatus(statusCode)
        if (failed) {
          const responseBody = await readResponseBody(upstream)
          const responseJson = tryJson(responseBody)
          const upstreamError = getUpstreamError(responseJson)
          const capacityError = isCapacityError(responseBody.toString("utf8")) || isCapacityError(upstreamError.message)
          const retryAllowed = capacityError ? attempt < config.capacityRetryCount : attempt < config.retryCount
          if (retryAllowed) {
            const failedAttempts = ((activeId ? this.activeRequests.get(activeId)?.failedAttempts : 0) || 0) + 1
            this.activeRequests.update(activeId, {
              failedAttempts,
              status: "retry_waiting_first_response",
              lastError: capacityError ? "Selected model is at capacity." : `HTTP ${statusCode}`,
            })
            await delay(config.retryDelayMs)
            continue
          }
          this.activeRequests.update(activeId, { responseStatus: statusCode })
          clientRes.writeHead(statusCode, upstream.headers)
          clientRes.end(responseBody)
          this.logStore.finalize(logId, {
            status: "upstream_error",
            responseStatus: statusCode,
            durationMs: Date.now() - started,
            target: `${targetUrl.origin}${finalPath}`,
            response: {
              headers: redactHeaders(upstream.headers),
              body: responseJson,
              capturedBytes: responseBody.length,
              totalBytes: responseBody.length,
              truncated: false,
            },
            error: capacityError ? "Selected model is at capacity." : upstreamError.message,
            errorCode: capacityError ? "model_capacity" : upstreamError.code,
            errorOrigin: "upstream",
          })
          return
        }
        this.activeRequests.update(activeId, {
          status:
            ((activeId ? this.activeRequests.get(activeId)?.failedAttempts : 0) || 0) > 0
              ? "retry_streaming"
              : "streaming",
          responseStatus: upstream.statusCode || 502,
        })
        if (routeOnly) {
          this.pipeRouteOnlyResponse(upstream, clientRes, logId, started, targetUrl.origin, finalPath, activeId)
          return
        }
        this.pipeResponse(
          upstream,
          clientRes,
          logId,
          started,
          targetUrl.origin,
          finalPath,
          isJsonArray(outbound.body?.input) ? outbound.body.input : [],
          {
            sessionId: headerValue(outbound.headers["session-id"]) ?? null,
            sourceInteractionId: outbound.sourceInteractionId ?? null,
            parentResponseId: outbound.previousResponseId ?? null,
            provider: publicProvider(provider),
            logId,
          },
          activeId,
        )
        return
      } catch (error) {
        lastError = error
        const current = activeId ? this.activeRequests.get(activeId) : undefined
        if (!current || current.cancelled || current.status === "timed_out" || errorCode(error) === "request_cancelled")
          throw new RequestCancelledError()
        if (attempt < config.retryCount) {
          const failedAttempts = ((activeId ? this.activeRequests.get(activeId)?.failedAttempts : 0) || 0) + 1
          this.activeRequests.update(activeId, {
            failedAttempts,
            status: "retry_waiting_first_response",
            lastError: errorMessage(error),
          })
          await delay(config.retryDelayMs)
          continue
        }
        break
      }
    }
    throw lastError || new Error("Forwarding failed.")
  }

  pipeRouteOnlyResponse(
    upstream: http.IncomingMessage,
    clientRes: http.ServerResponse,
    logId: string | null,
    started: number,
    targetOrigin: string,
    finalPath: string,
    activeId: string | null = null,
  ): void {
    const responseChunks: Buffer[] = []
    let responseBytes = 0
    let streamFinished = false
    const maxCapturedBytes = 5 * 1024 * 1024
    clientRes.writeHead(upstream.statusCode || 502, upstream.headers)
    upstream.on("data", (chunk) => {
      if (responseBytes < maxCapturedBytes) responseChunks.push(chunk.subarray(0, maxCapturedBytes - responseBytes))
      responseBytes += chunk.length
    })
    upstream.on("end", () => {
      streamFinished = true
      streamFinished = true
      const response = tryJson(Buffer.concat(responseChunks).toString("utf8"))
      const statusCode = upstream.statusCode || 502
      const upstreamError = statusCode >= 400 ? getUpstreamError(response) : null
      this.logStore.finalize(logId, {
        status: statusCode >= 400 ? "upstream_error" : "completed",
        responseStatus: statusCode,
        durationMs: Date.now() - started,
        target: `${targetOrigin}${finalPath}`,
        response: {
          headers: redactHeaders(upstream.headers),
          body: response,
          capturedBytes: Math.min(responseBytes, maxCapturedBytes),
          totalBytes: responseBytes,
          truncated: responseBytes > maxCapturedBytes,
        },
        ...(upstreamError
          ? { error: upstreamError.message, errorCode: upstreamError.code, errorOrigin: "upstream" }
          : {}),
      })
    })
    const handleStreamDisconnect = (error: unknown): void => {
      if (streamFinished) return
      streamFinished = true
      const active = activeId ? this.activeRequests.get(activeId) : undefined
      if (!active || active.cancelled || active.status === "timed_out") return
      const message = `Stream disconnected before completion: ${errorMessage(error)}`
      this.logStore.finalize(logId, {
        status: "upstream_error",
        error: message,
        durationMs: Date.now() - started,
      })
      this.activeRequests.finish(activeId)
      if (!clientRes.writableEnded) {
        if (clientRes.headersSent) clientRes.end()
        else sendJson(clientRes, 502, { error: message })
      }
    }
    upstream.on("error", handleStreamDisconnect)
    upstream.on("aborted", () => handleStreamDisconnect(new Error("upstream response aborted")))
    upstream.pipe(clientRes)
  }

  pipeResponse(
    upstream: http.IncomingMessage,
    clientRes: http.ServerResponse,
    logId: string | null,
    started: number,
    targetOrigin: string,
    finalPath: string,
    requestInput: JsonArray,
    contextMetadata: ResponseContextMetadata,
    activeId: string | null = null,
  ): void {
    const active = activeId ? this.activeRequests.get(activeId) : undefined
    if (active) active.upstreamResponse = upstream
    const responseChunks: Buffer[] = []
    let responseBytes = 0
    let streamFinished = false
    const maxCapturedBytes = 5 * 1024 * 1024
    const contextObserver: ResponseContextObserver | null = logId
      ? createResponseContextObserver(upstream, this.logStore, logId, requestInput, this.contextStore, contextMetadata)
      : null
    clientRes.writeHead(upstream.statusCode || 502, upstream.headers)
    upstream.on("data", (chunk) => {
      if (responseBytes < maxCapturedBytes) responseChunks.push(chunk.subarray(0, maxCapturedBytes - responseBytes))
      responseBytes += chunk.length
    })
    upstream.on("end", () => {
      streamFinished = true
      const responseText = Buffer.concat(responseChunks).toString("utf8")
      const parsedResponse = tryJson(responseText)
      const statusCode = upstream.statusCode || 502
      const active = activeId ? this.activeRequests.get(activeId) : undefined
      const canPersistContext = !activeId || Boolean(active && !active.cancelled && active.status !== "timed_out")
      const complete = contextObserver?.completeResponse(
        isJsonObject(parsedResponse) ? parsedResponse : undefined,
        canPersistContext && statusCode >= 200 && statusCode < 400,
      )
      const responseJson = complete?.response || parsedResponse
      const usage = usageFrom(complete?.usage || responseJson.usage)
      const upstreamError = statusCode >= 400 ? getUpstreamError(responseJson) : null
      this.logStore.finalize(logId, {
        status: statusCode >= 400 ? "upstream_error" : "completed",
        responseStatus: statusCode,
        durationMs: Date.now() - started,
        target: `${targetOrigin}${finalPath}`,
        response: {
          headers: redactHeaders(upstream.headers),
          body: responseJson,
          capturedBytes: Math.min(responseBytes, maxCapturedBytes),
          totalBytes: responseBytes,
          truncated: responseBytes > maxCapturedBytes,
        },
        ...(usage ? { usage } : {}),
        ...(upstreamError
          ? { error: upstreamError.message, errorCode: upstreamError.code, errorOrigin: "upstream" }
          : {}),
      })
    })
    const handleStreamDisconnect = (error: unknown): void => {
      if (streamFinished) return
      streamFinished = true
      const active = activeId ? this.activeRequests.get(activeId) : undefined
      if (!active || active.cancelled || active.status === "timed_out") return
      const message = `Stream disconnected before completion: ${errorMessage(error)}`
      this.logStore.finalize(logId, {
        status: "upstream_error",
        error: message,
        durationMs: Date.now() - started,
      })
      this.activeRequests.finish(activeId)
      if (!clientRes.writableEnded) {
        if (clientRes.headersSent) clientRes.end()
        else sendJson(clientRes, 502, { error: message })
      }
    }
    upstream.on("error", handleStreamDisconnect)
    upstream.on("aborted", () => handleStreamDisconnect(new Error("upstream response aborted")))
    upstream.pipe(clientRes)
  }

  fail(res: http.ServerResponse, logId: string | null, error: unknown, durationMs?: number): void {
    const status = error instanceof HttpError ? error.status : errorStatus(error) || 502
    if (logId)
      this.logStore.finalize(logId, {
        status: "failed",
        responseStatus: status,
        error: errorMessage(error),
        errorCode: errorCode(error),
        errorOrigin: "local",
        ...(durationMs === undefined ? {} : { durationMs }),
      })
    if (!res.headersSent) sendJson(res, status, { error: errorMessage(error) })
  }

  handleUpgrade(req: http.IncomingMessage, clientSocket: Duplex, head: Buffer): void {
    const route = resolveRoute(req.url, this.getConfig().providers)
    if (!route?.provider?.enabled) {
      clientSocket.destroy()
      return
    }
    try {
      const target = new URL(route.provider.baseUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:"))
      const isSecure = target.protocol === "https:"
      const port = target.port ? Number(target.port) : isSecure ? 443 : 80
      const upstream: net.Socket = isSecure
        ? tls.connect({ host: target.hostname, port, servername: target.hostname })
        : net.connect({ port, host: target.hostname })
      upstream.on("connect", () => {
        const basePath = target.pathname.endsWith("/") ? target.pathname.slice(0, -1) : target.pathname
        let raw = `${req.method || "GET"} ${basePath}${route.upstreamPath} HTTP/1.1\r\n`
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          const headerName = req.rawHeaders[i]
          const headerValue = req.rawHeaders[i + 1]
          if (headerName === undefined || headerValue === undefined) continue
          raw += `${headerName.toLowerCase() === "host" ? "Host" : headerName}: ${headerName.toLowerCase() === "host" ? target.host : headerValue}\r\n`
        }
        upstream.write(`${raw}\r\n`)
        if (head?.length) upstream.write(head)
        upstream.pipe(clientSocket)
        clientSocket.pipe(upstream)
      })
      upstream.on("error", () => clientSocket.destroy())
      clientSocket.on("error", () => upstream.destroy())
    } catch {
      clientSocket.destroy()
    }
  }
}

function resolveRoute(rawUrl: string | undefined, providers: readonly Provider[]): Route | null {
  const url = new URL(rawUrl || "/", "http://localhost")
  const match = url.pathname.match(/^\/([^/]+)\/v1(?:\/(.*))?$/)
  if (!match) return null
  const slug = match[1]
  if (!slug) return null
  const provider = providers.find((item) => item.slug === slug)
  if (!provider) return null
  return { provider, upstreamPath: `/${match[2] || ""}${url.search}` }
}
function makeRequest(
  protocol: Pick<typeof http, "request">,
  options: http.RequestOptions,
  body: Buffer,
  activeRequest: ActiveRequest | undefined,
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = protocol.request(options, resolve)
    if (activeRequest) activeRequest.upstreamRequest = request
    request.on("error", reject)
    request.end(body)
  })
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error?: Error) => (error ? reject(error) : resolve()))
  })
}

function logOutbound(outbound: OutboundRequest): Record<string, unknown> {
  return { headers: redactHeaders(outbound.headers), body: outbound.body, method: outbound.method, path: outbound.path }
}
function jsonObjectFrom(value: JsonObject): JsonObject {
  return value
}
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}
class RequestCancelledError extends Error {
  readonly code = "request_cancelled"
  constructor() {
    super("Request cancelled from dashboard.")
  }
}

function shouldRetryUpstreamStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500
}

export { isCapacityError, ProxyService, resolveRoute, shouldRetryUpstreamStatus }
