import { EventEmitter } from "node:events"
import * as fs from "node:fs"
import * as path from "node:path"
import { isJsonObject, type RequestLog, type RequestLogSummary, type Usage } from "../core/types"
import { RouterDatabase } from "./sqlite-store"

class RequestLogStore extends EventEmitter {
  readonly database: RouterDatabase
  readonly legacyPath: string
  shouldRecord: () => boolean
  readonly maxEntries: number
  readonly previousInputs: Map<string, string>

  constructor(dataDirectory: string, shouldRecord: () => boolean, database?: RouterDatabase) {
    super()
    this.database = database || new RouterDatabase(dataDirectory)
    this.legacyPath = path.join(dataDirectory, "request-logs.json")
    this.shouldRecord = shouldRecord
    this.maxEntries = 200
    this.previousInputs = new Map()
    this.database.migrate("request-logs-json-v1", () => {
      for (const log of this.readLegacy()) this.save(log)
      this.database.trimLogs(this.maxEntries)
    })
  }

  get logs(): RequestLog[] {
    return this.load()
  }

  setRecording(enabled: boolean): void {
    this.shouldRecord = () => Boolean(enabled)
  }

  create(entry: Omit<RequestLog, "createdAt" | "id" | "status">): string | null {
    if (!this.shouldRecord()) return null
    const log: RequestLog = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      createdAt: new Date().toISOString(),
      status: "processing",
      ...entry,
    }
    this.save(log)
    this.database.trimLogs(this.maxEntries)
    this.emit("changed", { type: "created", log: this.summary(log) })
    return log.id
  }

  update(id: string | null, values: Partial<RequestLog>): void {
    if (!id) return
    const log = this.get(id)
    if (!log) return
    Object.assign(log, values)
    this.save(log)
    this.emit("changed", { type: "updated", log: this.summary(log) })
  }

  finalize(id: string | null, values: Partial<RequestLog>): void {
    if (!id) return
    const log = this.get(id)
    if (!log) return
    Object.assign(log, values, { completedAt: new Date().toISOString() })
    this.attachCacheEstimate(log)
    this.save(log)
    this.emit("changed", { type: "updated", log: this.summary(log) })
  }

  list(): RequestLogSummary[] {
    return this.logs.map((log) => this.summary(log))
  }

  get(id: string): RequestLog | null {
    const value = this.database.log(id)
    return isRequestLog(value) ? value : null
  }

  clear(): RequestLog[] {
    const removed = this.logs
    this.database.clearLogs()
    this.previousInputs.clear()
    this.emit("changed", { type: "cleared" })
    return removed
  }

  clearAfterDatabaseReset(): void {
    this.previousInputs.clear()
    this.emit("changed", { type: "cleared" })
  }

  remove(id: string): RequestLog | null {
    const removed = this.get(id)
    if (!removed) return null
    this.database.deleteLog(id)
    this.emit("changed", { type: "deleted", log: this.summary(removed) })
    return removed
  }

  removeSession(sessionId: string): RequestLog[] {
    const removed = this.logs.filter((log) => log.sessionId === sessionId)
    if (!removed.length) return removed
    this.database.deleteLogsBySession(sessionId)
    this.emit("changed", { type: "deleted-many", count: removed.length })
    return removed
  }

  detachResponseContext(responseId: string): void {
    for (const log of this.logs) {
      if (!isJsonObject(log.responseContext) || log.responseContext.responseId !== responseId) continue
      log.responseContext = { ...log.responseContext, deleted: true }
      this.save(log)
    }
  }

  summary(log: RequestLog): RequestLogSummary {
    return {
      id: log.id,
      createdAt: log.createdAt,
      ...(log.completedAt === undefined ? {} : { completedAt: log.completedAt }),
      status: log.status,
      ...(log.provider === undefined ? {} : { provider: log.provider }),
      ...(log.sessionId === undefined ? {} : { sessionId: log.sessionId }),
      ...(log.sourceInteractionId === undefined ? {} : { sourceInteractionId: log.sourceInteractionId }),
      ...(log.method === undefined ? {} : { method: log.method }),
      ...(log.path === undefined ? {} : { path: log.path }),
      ...(log.responseStatus === undefined ? {} : { responseStatus: log.responseStatus }),
      ...(log.durationMs === undefined ? {} : { durationMs: log.durationMs }),
      ...(log.error === undefined ? {} : { error: log.error }),
      ...(log.usage === undefined ? {} : { usage: log.usage }),
      ...(log.cacheComparison === undefined ? {} : { cacheComparison: log.cacheComparison }),
      ...(log.transform?.mode === undefined ? {} : { transformMode: log.transform.mode }),
    }
  }

  attachCacheEstimate(log: RequestLog): void {
    const sessionKey = `${log.provider?.slug || "unknown"}:${log.sessionId || "unknown"}`
    const outboundBody = isJsonObject(log.outbound) && isJsonObject(log.outbound.body) ? log.outbound.body : null
    const current = outboundBody?.input ? JSON.stringify(outboundBody.input) : ""
    const previous = this.previousInputs.get(sessionKey) || ""
    const overlapChars = commonPrefixLength(previous, current)
    const estimatedPercent = current.length ? round((overlapChars / current.length) * 100) : null
    const usage: Usage = log.usage || {}
    const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? null
    const cachedTokens = usage.input_tokens_details?.cached_tokens ?? usage.cached_tokens ?? null
    const actualPercent = inputTokens && cachedTokens !== null ? round((cachedTokens / inputTokens) * 100) : null
    log.cacheComparison = {
      method:
        "Longest common prefix of successive serialized input values. This is a character-based estimate, not a token count.",
      overlapChars,
      currentChars: current.length,
      estimatedPercent,
      actualCachedTokens: cachedTokens,
      actualInputTokens: inputTokens,
      actualPercent,
      anomalous: estimatedPercent !== null && actualPercent !== null && Math.abs(estimatedPercent - actualPercent) > 15,
    }
    if (current) this.previousInputs.set(sessionKey, current)
  }

  load(): RequestLog[] {
    return this.database.logs().filter(isRequestLog).slice(0, this.maxEntries)
  }

  readLegacy(): RequestLog[] {
    try {
      const result: unknown = JSON.parse(fs.readFileSync(this.legacyPath, "utf8"))
      return Array.isArray(result) ? result.filter(isRequestLog).slice(0, this.maxEntries) : []
    } catch {
      return []
    }
  }

  save(log: RequestLog): void {
    this.database.saveLog(log.id, log.createdAt, log.sessionId || null, log)
  }
}

function isRequestLog(value: unknown): value is RequestLog {
  return (
    isJsonObject(value) &&
    typeof value.id === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.status === "string"
  )
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1
  return index
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

export { RequestLogStore }
