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
  type ModelMapping,
  type Provider,
  type ResponseContextMetadata,
  type RouterConfig,
  type TransformTrace,
} from "../core/types"
import type { RequestLogStore } from "../storage/request-log"
import type { ResponseContextStore } from "../storage/response-context"
import { type ActiveRequest, ActiveRequestTracker, type PublicActiveRequest } from "./active-request-tracker"
import { anthropicError, anthropicToResponses, responsesToAnthropic } from "./anthropic-compat"
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
      const modelRewrite = rewriteModelBuffer(rawBody, route.provider.modelMappings ?? [])
      const requestBody = modelRewrite.bodyBuffer
      const config = this.getConfig()
      const started = Date.now()
      // A route-only provider is already Anthropic-compatible. Preserve its Messages
      // request instead of translating it through the OpenAI Responses endpoint.
      if (isAnthropicMessagesPath(route.upstreamPath) && route.provider.routeOnly !== true) {
        try {
          await this.handleAnthropicMessages(route, req, res, rawBody, activeRequest.id, started, config)
        } catch (error) {
          this.activeRequests.finish(activeRequest.id)
          if (error instanceof RequestCancelledError) return
          this.fail(res, null, error, Date.now() - started)
        }
        return
      }
      const routeOnly = route.provider.routeOnly === true
      let outbound: OutboundRequest = routeOnly
        ? {
            headers: { ...req.headers },
            bodyBuffer: requestBody,
            method: req.method || "GET",
            path: route.upstreamPath,
          }
        : {
            headers: { ...req.headers },
            body: jsonObjectFrom(tryJson(requestBody)),
            bodyBuffer: requestBody,
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
            requestBody,
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
          if (modelRewrite.changed) {
            transform.operations.push({
              type: "transformed",
              scope: "body",
              from: `body.model=${modelRewrite.from}`,
              to: `body.model=${modelRewrite.to}`,
              label: `Mapped model for provider ${route.provider.slug}`,
            })
          }
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

  async handleAnthropicMessages(
    route: Route,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawBody: Buffer,
    activeId: string,
    started: number,
    config: RouterConfig,
  ): Promise<void> {
    if (!config.forwardEnabled) throw new HttpError(503, "Forwarding is disabled in the dashboard.")
    const mappings = route.provider.modelMappings ?? []
    const original = tryJson(rawBody)
    const rewritten = rewriteModelObject(original, mappings)
    const incoming = isJsonObject(rewritten.body) ? rewritten.body : {}
    const mapping = isJsonObject(original) ? matchingModelMapping(original, mappings) : undefined
    if (mapping?.route === "messages") {
      await this.forwardAnthropicMessages(route, req, res, rawBody, rewritten, activeId, started)
      return
    }
    const anthropic = anthropicToResponses(incoming)
    // Anthropic-compatible clients need a plain OpenAI Responses request here. Applying the
    // Codex transform adds Codex-only fields which Claude-compatible upstreams may reject.
    const bodyBuffer = Buffer.from(JSON.stringify(anthropic.request))
    const sessionId = resolveSessionId(req.headers, route.provider)
    const outbound: OutboundRequest = {
      headers: {
        ...responsesHeaders(req.headers),
        "content-type": "application/json",
        "content-length": String(bodyBuffer.length),
      },
      body: anthropic.request,
      bodyBuffer,
      method: req.method || "POST",
      path: "/responses",
      sessionId,
    }
    const transform: TransformTrace = {
      mode: "passthrough",
      operations: [
        {
          type: "transformed",
          scope: "routing",
          from: req.url || "/",
          to: "/responses",
          label: "Translated Anthropic Messages request to the standard Responses endpoint",
        },
        {
          type: "transformed",
          scope: "body",
          from: "Anthropic Messages body",
          to: "standard Responses body",
          label: "Converted Anthropic content and tools without Codex request enrichment",
        },
      ],
    }
    const logId = this.logStore.create({
      provider: publicProvider(route.provider),
      method: req.method || "POST",
      path: req.url || "/",
      localUrl: `http://127.0.0.1:${config.routerPort}${req.url || "/"}`,
      sessionId,
      inbound: { headers: redactHeaders(req.headers), body: incoming, bytes: rawBody.length },
      transform,
      outbound: logOutbound(outbound),
    })
    this.activeRequests.update(activeId, {
      sessionId,
    })
    await this.forwardAnthropic(
      route.provider,
      outbound,
      rewritten.to || anthropic.model,
      anthropic.stream,
      res,
      logId,
      started,
      activeId,
    )
  }

  async forwardAnthropicMessages(
    route: Route,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawBody: Buffer,
    rewritten: ReturnType<typeof rewriteModelObject>,
    activeId: string,
    started: number,
  ): Promise<void> {
    const bodyBuffer = rewritten.changed ? Buffer.from(JSON.stringify(rewritten.body)) : rawBody
    const sessionId = resolveSessionId(req.headers, route.provider)
    const outbound: OutboundRequest = {
      headers: { ...req.headers, "content-length": String(bodyBuffer.length) },
      ...(isJsonObject(rewritten.body) ? { body: rewritten.body } : {}),
      bodyBuffer,
      method: req.method || "POST",
      path: "/messages",
      sessionId,
    }
    const logId = this.logStore.create({
      provider: publicProvider(route.provider),
      method: req.method || "POST",
      path: req.url || "/",
      localUrl: `http://127.0.0.1:${this.getConfig().routerPort}${req.url || "/"}`,
      sessionId,
      inbound: { headers: redactHeaders(req.headers), body: tryJson(rawBody), bytes: rawBody.length },
      transform: {
        mode: "passthrough",
        operations: [
          {
            type: "passed",
            scope: "routing",
            from: req.url || "/",
            to: "/messages",
            label: "Forwarded this model through its configured native Anthropic Messages route",
          },
        ],
      },
      outbound: logOutbound(outbound),
    })
    this.activeRequests.update(activeId, { sessionId })
    await this.forward(route.provider, outbound, res, logId, started, this.getConfig(), true, activeId)
  }

  async forwardAnthropic(
    provider: Provider,
    outbound: Pick<OutboundRequest, "headers" | "bodyBuffer" | "method" | "path">,
    requestedModel: string,
    stream: boolean,
    clientRes: http.ServerResponse,
    logId: string | null,
    started: number,
    activeId: string,
  ): Promise<void> {
    const targetUrl = new URL(provider.baseUrl)
    const basePath = targetUrl.pathname.endsWith("/") ? targetUrl.pathname.slice(0, -1) : targetUrl.pathname
    const finalPath = `${basePath}${outbound.path}`
    const protocol = targetUrl.protocol === "https:" ? https : http
    const upstream = await makeRequest(
      protocol,
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
        path: finalPath,
        method: outbound.method,
        headers: { ...outbound.headers, host: targetUrl.host },
      },
      outbound.bodyBuffer,
      this.activeRequests.get(activeId),
    )
    const statusCode = upstream.statusCode || 502
    this.activeRequests.update(activeId, { status: "streaming", responseStatus: statusCode })
    if (statusCode >= 400) {
      const body = tryJson(await readResponseBody(upstream))
      const error = anthropicError(statusCode, body)
      sendJson(clientRes, statusCode, error)
      this.logStore.finalize(logId, {
        status: "upstream_error",
        responseStatus: statusCode,
        durationMs: Date.now() - started,
        target: `${targetUrl.origin}${finalPath}`,
        response: { headers: redactHeaders(upstream.headers), body, capturedBytes: 0, totalBytes: 0, truncated: false },
        error: String(error.error && isJsonObject(error.error) ? error.error.message : "Upstream request failed."),
        errorOrigin: "upstream",
      })
      this.activeRequests.finish(activeId)
      return
    }
    const eventStream = headerValue(upstream.headers["content-type"])?.includes("text/event-stream") === true
    if (stream && eventStream) {
      this.pipeAnthropicStream(
        upstream,
        clientRes,
        requestedModel,
        logId,
        started,
        `${targetUrl.origin}${finalPath}`,
        activeId,
      )
      return
    }
    const raw = await readResponseBody(upstream)
    const response = responsesToAnthropic(tryJson(raw), requestedModel)
    sendJson(clientRes, statusCode, response)
    this.logStore.finalize(logId, {
      status: "completed",
      responseStatus: statusCode,
      durationMs: Date.now() - started,
      target: `${targetUrl.origin}${finalPath}`,
      response: {
        headers: redactHeaders(upstream.headers),
        body: response,
        capturedBytes: raw.length,
        totalBytes: raw.length,
        truncated: false,
      },
    })
    this.activeRequests.finish(activeId)
  }

  pipeAnthropicStream(
    upstream: http.IncomingMessage,
    clientRes: http.ServerResponse,
    model: string,
    logId: string | null,
    started: number,
    target: string,
    activeId: string,
  ): void {
    clientRes.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" })
    let pending = ""
    let messageStarted = false
    let nextIndex = 0
    let usedToolCalls = false
    const open = new Map<number, "text" | "tool_use">()
    const startMessage = (id = "msg_router_stream"): void => {
      if (messageStarted) return
      messageStarted = true
      writeAnthropicEvent(clientRes, "message_start", {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })
    }
    const startBlock = (index: number, type: "text" | "tool_use", item: JsonObject = {}): void => {
      if (open.has(index)) return
      startMessage()
      open.set(index, type)
      nextIndex = Math.max(nextIndex, index + 1)
      writeAnthropicEvent(clientRes, "content_block_start", {
        type: "content_block_start",
        index,
        content_block:
          type === "text"
            ? { type: "text", text: "" }
            : {
                type: "tool_use",
                id: String(item.call_id || item.id || `toolu_${index}`),
                name: String(item.name || "tool"),
                input: {},
              },
      })
    }
    const closeBlock = (index: number): void => {
      if (!open.has(index)) return
      open.delete(index)
      writeAnthropicEvent(clientRes, "content_block_stop", { type: "content_block_stop", index })
    }
    const handle = (event: JsonObject): void => {
      const type = String(event.type || "")
      if (type === "response.created" && isJsonObject(event.response))
        startMessage(String(event.response.id || "msg_router_stream"))
      else if (type === "response.output_item.added" && isJsonObject(event.item)) {
        const index = typeof event.output_index === "number" ? event.output_index : nextIndex
        if (event.item.type === "function_call") {
          usedToolCalls = true
          startBlock(index, "tool_use", event.item)
        }
      } else if (type === "response.output_text.delta") {
        const index = typeof event.output_index === "number" ? event.output_index : nextIndex
        startBlock(index, "text")
        writeAnthropicEvent(clientRes, "content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: String(event.delta || "") },
        })
      } else if (type === "response.function_call_arguments.delta") {
        const index = typeof event.output_index === "number" ? event.output_index : nextIndex
        usedToolCalls = true
        startBlock(index, "tool_use")
        writeAnthropicEvent(clientRes, "content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: String(event.delta || "") },
        })
      } else if (type === "response.output_item.done") {
        const index = typeof event.output_index === "number" ? event.output_index : nextIndex - 1
        closeBlock(index)
      } else if (type === "response.completed") {
        startMessage(isJsonObject(event.response) ? String(event.response.id || "msg_router_stream") : undefined)
        for (const index of [...open.keys()]) closeBlock(index)
        const output =
          isJsonObject(event.response) && isJsonObject(event.response.usage) ? event.response.usage.output_tokens : 0
        writeAnthropicEvent(clientRes, "message_delta", {
          type: "message_delta",
          delta: { stop_reason: usedToolCalls ? "tool_use" : "end_turn", stop_sequence: null },
          usage: { output_tokens: typeof output === "number" ? output : 0 },
        })
        writeAnthropicEvent(clientRes, "message_stop", { type: "message_stop" })
      }
    }
    upstream.setEncoding("utf8")
    upstream.on("data", (chunk: string) => {
      pending += chunk
      let boundary = pending.indexOf("\n\n")
      while (boundary >= 0) {
        const block = pending.slice(0, boundary)
        pending = pending.slice(boundary + 2)
        const line = block.split(/\r?\n/).find((value) => value.startsWith("data:"))
        if (line) {
          try {
            const parsed: unknown = JSON.parse(line.slice(5).trim())
            if (isJsonObject(parsed)) handle(parsed)
          } catch {}
        }
        boundary = pending.indexOf("\n\n")
      }
    })
    upstream.on("end", () => {
      if (messageStarted && !clientRes.writableEnded) clientRes.end()
      this.logStore.finalize(logId, {
        status: "completed",
        responseStatus: 200,
        durationMs: Date.now() - started,
        target,
      })
      this.activeRequests.finish(activeId)
    })
    upstream.on("error", (error) => {
      if (!clientRes.writableEnded) clientRes.end()
      this.logStore.finalize(logId, {
        status: "upstream_error",
        error: errorMessage(error),
        durationMs: Date.now() - started,
      })
      this.activeRequests.finish(activeId)
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
        const isEventStream = headerValue(upstream.headers["content-type"])?.includes("text/event-stream") === true
        if (routeOnly) {
          if (isEventStream) await waitForFirstChunk(upstream)
          this.pipeRouteOnlyResponse(upstream, clientRes, logId, started, targetUrl.origin, finalPath, activeId)
          return
        }
        if (isEventStream) await waitForFirstChunk(upstream)
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

function isAnthropicMessagesPath(path: string): boolean {
  const queryStart = path.indexOf("?")
  const pathname = queryStart >= 0 ? path.slice(0, queryStart) : path
  return pathname === "/messages"
}

function responsesHeaders(headers: Headers): Headers {
  const result: Headers = {}
  // Do not forward Anthropic protocol and transport headers to /responses. In particular,
  // anthropic-beta can cause compatibility gateways to select an incompatible handler.
  for (const name of ["authorization", "x-api-key", "accept", "user-agent"]) {
    const value = headers[name]
    if (value !== undefined) result[name] = value
  }
  return result
}

function writeAnthropicEvent(res: http.ServerResponse, event: string, body: JsonObject): void {
  if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(body)}\n\n`)
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

function waitForFirstChunk(stream: http.IncomingMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      stream.off("data", onData)
      stream.off("error", onError)
      stream.off("aborted", onAborted)
      stream.off("close", onClose)
      callback()
    }
    const onData = (chunk: Buffer | string): void => {
      stream.pause()
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      stream.unshift(buffer)
      finish(resolve)
    }
    const onError = (error: Error): void => finish(() => reject(error))
    const onAborted = (): void => finish(() => reject(new Error("upstream response aborted before the first chunk")))
    const onClose = (): void => finish(() => reject(new Error("upstream response closed before the first chunk")))
    stream.once("data", onData)
    stream.once("error", onError)
    stream.once("aborted", onAborted)
    stream.once("close", onClose)
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

function rewriteModelBuffer(
  rawBody: Buffer,
  mappings: readonly ModelMapping[],
): { readonly bodyBuffer: Buffer; readonly changed: boolean; readonly from?: string; readonly to?: string } {
  const parsed = tryJson(rawBody)
  const rewritten = rewriteModelObject(parsed, mappings)
  return rewritten.changed
    ? { bodyBuffer: Buffer.from(JSON.stringify(rewritten.body)), ...rewritten }
    : { bodyBuffer: rawBody, ...rewritten }
}

function rewriteModelObject(
  value: unknown,
  mappings: readonly ModelMapping[],
): { readonly body: unknown; readonly changed: boolean; readonly from?: string; readonly to?: string } {
  if (!isJsonObject(value) || typeof value.model !== "string") return { body: value, changed: false }
  const model = value.model
  const mapping = matchingModelMapping(value, mappings)
  if (!mapping?.to || mapping.to === model) return { body: value, changed: false }
  return { body: { ...value, model: mapping.to }, changed: true, from: model, to: mapping.to }
}

function matchingModelMapping(value: JsonObject, mappings: readonly ModelMapping[]): ModelMapping | undefined {
  const model = value.model
  if (typeof model !== "string") return undefined
  return mappings.find((item) => item.enabled !== false && (item.from === model || matchesModelPattern(item.from, model)))
}

function matchesModelPattern(pattern: string, model: string): boolean {
  if (!pattern.includes("*") && !pattern.includes("?")) return false
  const expression = pattern
    .split(/([*?])/)
    .map((segment) => (segment === "*" ? ".*" : segment === "?" ? "." : escapeRegex(segment)))
    .join("")
  return new RegExp(`^${expression}$`).test(model)
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&")
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

export { isCapacityError, ProxyService, resolveRoute, rewriteModelObject, shouldRetryUpstreamStatus }
