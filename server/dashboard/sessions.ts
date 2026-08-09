import type { Provider, PublicProvider, RequestLog, ResponseContext, SessionSummary } from "../core/types"
import { isJsonObject } from "../core/types"
import type { RequestLogStore } from "../storage/request-log"
import type { ResponseContextStore } from "../storage/response-context"

export interface MissingContinuation {
  readonly responseId: string
  readonly createdAt: string
  readonly provider: Provider | PublicProvider | null | undefined
  readonly logId: string
}

export interface SessionWithRequestCount extends SessionSummary {
  requestCount: number
}

export const UNKNOWN_SESSION_KEY = "unknown"

export function matchesSessionKey(sessionId: string | null | undefined, sessionKey: string): boolean {
  return sessionKey === UNKNOWN_SESSION_KEY ? !sessionId : sessionId === sessionKey
}

export function listMissingContinuations(logs: RequestLogStore, contexts: ResponseContextStore): MissingContinuation[] {
  const unique = new Map<string, MissingContinuation>()
  for (const log of logs.logs) {
    const inboundBody = isJsonObject(log.inbound?.body) ? log.inbound.body : null
    const responseId = inboundBody?.previous_response_id
    if (typeof responseId !== "string" || contexts.get(responseId) || unique.has(responseId)) continue
    const localMissing =
      log.errorCode === "missing_continuation_context" ||
      (log.status === "failed" && log.responseStatus === 401 && !log.response)
    if (!localMissing) continue
    unique.set(responseId, { responseId, createdAt: log.createdAt, provider: log.provider, logId: log.id })
  }
  return [...unique.values()].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
}

export function listSessions(logs: RequestLogStore, contexts: ResponseContextStore): SessionWithRequestCount[] {
  const sessions = new Map<string, SessionWithRequestCount>()
  for (const contextSession of contexts.listSessions())
    sessions.set(contextSession.sessionId || UNKNOWN_SESSION_KEY, { ...contextSession, requestCount: 0 })
  for (const log of logs.list()) {
    const sessionId = log.sessionId || UNKNOWN_SESSION_KEY
    const current: SessionWithRequestCount = sessions.get(sessionId) || {
      sessionId: log.sessionId || null,
      provider: log.provider || null,
      label: null,
      imported: false,
      count: 0,
      responseIds: [],
      updatedAt: log.createdAt,
      requestCount: 0,
    }
    current.requestCount += 1
    if (String(log.createdAt) > String(current.updatedAt)) current.updatedAt = log.createdAt
    sessions.set(sessionId, current)
  }
  return [...sessions.values()].sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
}

export function reconcileStoredSessions(logStore: RequestLogStore, contextStore: ResponseContextStore): void {
  const logByResponseId = new Map<string, RequestLog>()
  for (const log of logStore.logs) {
    const responseId = log.responseContext?.responseId
    if (typeof responseId === "string") logByResponseId.set(responseId, log)
  }
  const resolving = new Set<string>()
  const resolveSession = (log: RequestLog | undefined): string | null => {
    if (!log || resolving.has(log.id)) return log?.sessionId || null
    resolving.add(log.id)
    const inboundBody = isJsonObject(log.inbound?.body) ? log.inbound.body : null
    const parentId = inboundBody?.previous_response_id
    const parent = typeof parentId === "string" ? logByResponseId.get(parentId) : undefined
    const sessionId = parent ? resolveSession(parent) : log.sessionId
    resolving.delete(log.id)
    return sessionId || null
  }
  for (const log of logStore.logs) {
    const sessionId = resolveSession(log)
    if (sessionId && log.sessionId !== sessionId) logStore.update(log.id, { sessionId })
  }
  for (const context of contextStore.contexts) reconcileContext(context, logByResponseId, contextStore)
}

function reconcileContext(
  context: ResponseContext,
  logByResponseId: ReadonlyMap<string, RequestLog>,
  contextStore: ResponseContextStore,
): void {
  const log = logByResponseId.get(context.responseId)
  const sessionId = log?.sessionId || context.sessionId
  const logInbound = isJsonObject(log?.inbound?.body) ? log.inbound.body : null
  const parentResponseId =
    typeof logInbound?.previous_response_id === "string" ? logInbound.previous_response_id : context.parentResponseId
  const values: Partial<ResponseContext> = {}
  if (sessionId && context.sessionId !== sessionId) values.sessionId = sessionId
  if (parentResponseId && context.parentResponseId !== parentResponseId) values.parentResponseId = parentResponseId
  if (Object.keys(values).length) contextStore.update(context.responseId, values)
}
