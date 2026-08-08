import type * as http from "node:http"
import type { PublicProvider } from "../core/types"
import type { RequestLogStore } from "../storage/request-log"
import { sendJson } from "./http-utils"

export interface ActiveRequest {
  readonly id: string
  readonly createdAt: string
  readonly provider: PublicProvider
  readonly routeOnly: boolean
  readonly method: string
  readonly path: string
  sessionId: string
  sourceInteractionId?: string | null
  status: string
  failedAttempts: number
  attempt: number
  cancelled: boolean
  logId: string | null
  lastError?: string
  responseStatus?: number
  timeoutHandle: ReturnType<typeof setTimeout> | null
  upstreamRequest: http.ClientRequest | null
  upstreamResponse: http.IncomingMessage | null
  clientRes: http.ServerResponse | null
}

export interface PublicActiveRequest {
  readonly id: string
  readonly createdAt: string
  readonly provider: PublicProvider
  readonly routeOnly: boolean
  readonly method: string
  readonly path: string
  readonly sessionId: string
  readonly sourceInteractionId?: string | null
  readonly status: string
  readonly failedAttempts: number
  readonly attempt: number
  readonly cancelled: boolean
  readonly logId: string | null
  readonly lastError?: string
  readonly responseStatus?: number
  readonly elapsedMs?: number
}

interface NewActiveRequest {
  readonly provider: PublicProvider
  readonly routeOnly: boolean
  readonly method: string
  readonly path: string
  readonly sessionId: string
}

interface TrackerDependencies {
  readonly timeoutMs: () => number
  readonly logStore: RequestLogStore
  readonly notify: (event: Record<string, unknown>) => void
}

export class ActiveRequestTracker {
  readonly requests = new Map<string, ActiveRequest>()

  constructor(readonly dependencies: TrackerDependencies) {}

  get size(): number {
    return this.requests.size
  }

  get(id: string | null): ActiveRequest | undefined {
    return id ? this.requests.get(id) : undefined
  }

  begin(values: NewActiveRequest): ActiveRequest {
    const request: ActiveRequest = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      createdAt: new Date().toISOString(),
      ...values,
      status: "waiting_first_response",
      failedAttempts: 0,
      attempt: 1,
      cancelled: false,
      logId: null,
      timeoutHandle: null,
      upstreamRequest: null,
      upstreamResponse: null,
      clientRes: null,
    }
    request.timeoutHandle = setTimeout(() => this.expire(request.id), this.dependencies.timeoutMs())
    request.timeoutHandle.unref?.()
    this.requests.set(request.id, request)
    this.dependencies.notify({ type: "active-created", request: this.public(request) })
    return request
  }

  update(id: string | null, values: Partial<ActiveRequest>): void {
    const request = this.get(id)
    if (!request) return
    Object.assign(request, values)
    this.dependencies.notify({ type: "active-updated", request: this.public(request) })
  }

  watchClientResponse(clientRes: http.ServerResponse, id: string | null): void {
    const request = this.get(id)
    if (request) request.clientRes = clientRes
    const finish = (): void => this.finish(id)
    clientRes.once("finish", finish)
    clientRes.once("close", finish)
  }

  setUpstreamRequest(id: string | null, upstreamRequest: http.ClientRequest): void {
    const request = this.get(id)
    if (request) request.upstreamRequest = upstreamRequest
  }

  setUpstreamResponse(id: string | null, upstreamResponse: http.IncomingMessage): void {
    const request = this.get(id)
    if (request) request.upstreamResponse = upstreamResponse
  }

  finish(id: string | null): void {
    if (!id) return
    const request = this.requests.get(id)
    if (request?.timeoutHandle) clearTimeout(request.timeoutHandle)
    if (!this.requests.delete(id)) return
    this.dependencies.notify({ type: "active-finished", requestId: id })
  }

  cancel(id: string): { readonly found: boolean; readonly cancelled?: boolean } {
    const request = this.requests.get(id)
    if (!request) return { found: false }
    if (request.cancelled) return { found: true, cancelled: true }
    request.cancelled = true
    request.status = "cancelled"
    if (request.logId)
      this.dependencies.logStore.finalize(request.logId, {
        status: "cancelled",
        responseStatus: 499,
        error: "Request cancelled from dashboard.",
        errorCode: "request_cancelled",
        errorOrigin: "local",
      })
    this.dependencies.notify({ type: "active-updated", request: this.public(request) })
    request.upstreamResponse?.destroy()
    request.upstreamRequest?.destroy(new Error("Request cancelled from dashboard."))
    this.respondWithError(request, 499, "request_cancelled", "Request cancelled from dashboard.")
    this.finish(id)
    return { found: true, cancelled: true }
  }

  cancelAll(): void {
    for (const id of [...this.requests.keys()]) this.cancel(id)
  }

  list(): PublicActiveRequest[] {
    const now = Date.now()
    return [...this.requests.values()]
      .map((request) => ({ ...this.public(request), elapsedMs: Math.max(0, now - Date.parse(request.createdAt)) }))
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
  }

  expire(id: string): void {
    const request = this.requests.get(id)
    if (!request || request.cancelled || request.status === "timed_out") return
    request.status = "timed_out"
    request.lastError = "Request timed out before the upstream response completed."
    request.responseStatus = 504
    if (request.logId) {
      this.dependencies.logStore.finalize(request.logId, {
        status: "failed",
        responseStatus: 504,
        error: "Request timed out before the upstream response completed.",
        errorCode: "request_timeout",
        errorOrigin: "local",
      })
    }
    this.dependencies.notify({ type: "active-updated", request: this.public(request) })
    request.upstreamResponse?.destroy(new Error("Request timed out before the upstream response completed."))
    request.upstreamRequest?.destroy(new Error("Request timed out before the upstream response completed."))
    this.respondWithError(request, 504, "request_timeout", "Request timed out before the upstream response completed.")
    this.finish(id)
  }

  private public(request: ActiveRequest): PublicActiveRequest {
    const { timeoutHandle, upstreamRequest, upstreamResponse, clientRes, ...publicRequest } = request
    return publicRequest
  }

  private respondWithError(request: ActiveRequest, status: number, code: string, message: string): void {
    if (!request.clientRes || request.clientRes.writableEnded) return
    if (request.clientRes.headersSent) {
      request.clientRes.write(`data: ${JSON.stringify({ type: "error", error: { code, message } })}\n\n`)
      request.clientRes.end()
      return
    }
    sendJson(request.clientRes, status, { error: { code, message } })
  }
}
