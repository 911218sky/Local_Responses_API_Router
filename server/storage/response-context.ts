import { EventEmitter } from "node:events"
import * as fs from "node:fs"
import * as path from "node:path"
import {
  isJsonArray,
  isJsonObject,
  type JsonArray,
  type ResponseContext,
  type ResponseContextMetadata,
  type ResponseContextSummary,
  type SessionSummary,
} from "../core/types"
import { RouterDatabase } from "./sqlite-store"

class ResponseContextStore extends EventEmitter {
  readonly database: RouterDatabase
  readonly legacyPath: string
  shouldPersist: () => boolean
  readonly maxEntries: number
  readonly volatileContexts: Map<string, ResponseContext>

  constructor(dataDirectory: string, shouldPersist: () => boolean = () => true, database?: RouterDatabase) {
    super()
    this.database = database || new RouterDatabase(dataDirectory)
    this.legacyPath = path.join(dataDirectory, "response-contexts.json")
    this.shouldPersist = shouldPersist
    this.maxEntries = 500
    this.volatileContexts = new Map()
    this.database.migrate("response-contexts-json-v1", () => {
      for (const context of this.readLegacy()) this.savePersisted(context)
      this.database.trimContexts(this.maxEntries)
    })
    this.compact()
  }

  get contexts(): ResponseContext[] {
    const contexts = new Map<string, ResponseContext>()
    for (const value of this.database.contexts()) {
      if (validContext(value)) contexts.set(value.responseId, value)
    }
    for (const context of this.volatileContexts.values()) contexts.set(context.responseId, context)
    return [...contexts.values()]
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
      .slice(0, this.maxEntries)
  }

  get(responseId: string): ResponseContext | null {
    const volatile = this.volatileContexts.get(responseId)
    if (volatile) return volatile
    const value = this.database.context(responseId)
    return validContext(value) ? value : null
  }

  getHistory(responseId: string, visiting: ReadonlySet<string> = new Set()): JsonArray | null {
    const context = this.get(responseId)
    if (!context || visiting.has(responseId)) return null
    const parentHistory = context.parentResponseId
      ? this.getHistory(context.parentResponseId, new Set([...visiting, responseId]))
      : []
    if (context.parentResponseId && !parentHistory) return null
    return [...(parentHistory || []), ...context.requestInput, ...context.responseOutput]
  }

  getSessionReplay(
    sessionId: string | null,
  ): { readonly context: ResponseContextSummary; readonly history: JsonArray } | null {
    const contexts = this.contexts.filter((context) => context.sessionId === sessionId)
    if (!contexts.length) return null
    const parentIds = new Set(
      contexts.flatMap((context) => (context.parentResponseId ? [context.parentResponseId] : [])),
    )
    const finalContext = contexts
      .filter((context) => !parentIds.has(context.responseId))
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0]
    return finalContext
      ? { context: this.summary(finalContext), history: this.getHistory(finalContext.responseId) || [] }
      : null
  }

  save(
    responseId: string,
    requestInput: JsonArray,
    responseOutput: JsonArray,
    metadata: ResponseContextMetadata = {},
  ): ResponseContext | null {
    if (!responseId || !Array.isArray(requestInput) || !Array.isArray(responseOutput)) return null
    const now = new Date().toISOString()
    const existing = this.get(responseId)
    const parentHistory = metadata.parentResponseId ? this.getHistory(metadata.parentResponseId) : []
    const requestInputDelta =
      parentHistory && startsWithItems(requestInput, parentHistory)
        ? requestInput.slice(parentHistory.length)
        : requestInput
    const context: ResponseContext = {
      responseId,
      sessionId: metadata.sessionId || existing?.sessionId || null,
      sourceInteractionId: metadata.sourceInteractionId || existing?.sourceInteractionId || null,
      parentResponseId: metadata.parentResponseId || existing?.parentResponseId || null,
      imported: metadata.imported === true || existing?.imported === true,
      label: metadata.label || existing?.label || null,
      provider: metadata.provider || existing?.provider || null,
      logId: metadata.logId || existing?.logId || null,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      requestInput: requestInputDelta,
      responseOutput,
    }
    this.persistContext(context)
    this.emit("changed", { type: existing ? "updated" : "created", context: this.summary(context) })
    return context
  }

  listSessions(): SessionSummary[] {
    const sessions = new Map<string, SessionSummary>()
    for (const context of this.contexts) {
      const key = context.sessionId || "unknown"
      const current = sessions.get(key) || {
        sessionId: context.sessionId,
        provider: context.provider,
        label: context.label,
        imported: context.imported,
        count: 0,
        updatedAt: context.updatedAt,
        responseIds: [],
      }
      current.count += 1
      current.responseIds.push(context.responseId)
      if (!current.label && context.label) current.label = context.label
      current.imported = current.imported || context.imported === true
      if (String(context.updatedAt) > String(current.updatedAt)) current.updatedAt = context.updatedAt
      sessions.set(key, current)
    }
    return [...sessions.values()].sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
  }

  remove(responseId: string): ResponseContext | null {
    const removed = this.get(responseId)
    if (!removed) return null
    this.database.deleteContext(responseId)
    this.volatileContexts.delete(responseId)
    this.emit("changed", { type: "deleted", context: this.summary(removed) })
    return removed
  }

  update(responseId: string, values: Partial<ResponseContext>): void {
    const context = this.get(responseId)
    if (!context) return
    Object.assign(context, values)
    this.persistContext(context)
  }

  removeByLogIds(logIds: readonly string[]): ResponseContext[] {
    const ids = new Set(logIds)
    const removed = this.contexts.filter((context) => context.logId && ids.has(context.logId))
    if (!removed.length) return removed
    this.database.deleteContextsByLogIds(logIds)
    for (const context of removed) this.volatileContexts.delete(context.responseId)
    this.emit("changed", {
      type: "deleted-many",
      count: removed.length,
      responseIds: removed.map((context) => context.responseId),
    })
    return removed
  }

  removeSession(sessionId: string): ResponseContext[] {
    const removed = this.contexts.filter((context) => context.sessionId === sessionId)
    if (!removed.length) return removed
    this.database.deleteContextsBySession(sessionId)
    for (const context of removed) this.volatileContexts.delete(context.responseId)
    this.emit("changed", {
      type: "deleted-many",
      count: removed.length,
      responseIds: removed.map((context) => context.responseId),
    })
    return removed
  }

  clear(): ResponseContext[] {
    const removed = this.contexts
    this.database.clearContexts()
    this.volatileContexts.clear()
    this.emit("changed", { type: "cleared", count: removed.length })
    return removed
  }

  clearAfterDatabaseReset(count = this.contexts.length): void {
    this.volatileContexts.clear()
    this.emit("changed", { type: "cleared", count })
  }

  summary(context: ResponseContext): ResponseContextSummary {
    return {
      responseId: context.responseId,
      sessionId: context.sessionId,
      sourceInteractionId: context.sourceInteractionId,
      parentResponseId: context.parentResponseId,
      imported: context.imported === true,
      label: context.label,
      provider: context.provider,
      logId: context.logId,
      createdAt: context.createdAt,
      updatedAt: context.updatedAt,
      inputItemCount: context.requestInput.length,
      outputItemCount: context.responseOutput.length,
    }
  }

  listBySession(sessionId: string | null): ResponseContextSummary[] {
    return this.contexts.filter((context) => context.sessionId === sessionId).map((context) => this.summary(context))
  }

  compact(): void {
    for (const context of this.contexts) {
      if (!context.parentResponseId) continue
      const parentHistory = this.getHistory(context.parentResponseId)
      if (!parentHistory || !startsWithItems(context.requestInput || [], parentHistory)) continue
      context.requestInput = context.requestInput.slice(parentHistory.length)
      this.persistContext(context)
    }
  }

  readLegacy(): ResponseContext[] {
    try {
      const contexts: unknown = JSON.parse(fs.readFileSync(this.legacyPath, "utf8"))
      return Array.isArray(contexts) ? contexts.filter(validContext).slice(0, this.maxEntries) : []
    } catch {
      return []
    }
  }

  persistContext(context: ResponseContext): void {
    if (this.shouldPersist()) {
      this.savePersisted(context)
      this.volatileContexts.delete(context.responseId)
      const evicted = this.database.trimContexts(this.maxEntries)
      for (const responseId of evicted) this.volatileContexts.delete(responseId)
      if (evicted.length) this.emit("changed", { type: "deleted-many", count: evicted.length, responseIds: evicted })
      return
    }
    this.volatileContexts.set(context.responseId, context)
    while (this.volatileContexts.size > this.maxEntries) {
      const oldest = this.volatileContexts.keys().next().value
      if (typeof oldest !== "string") break
      this.volatileContexts.delete(oldest)
    }
  }

  savePersisted(context: ResponseContext): void {
    this.database.saveContext(context.responseId, context.updatedAt, context.sessionId, context.logId, context)
  }
}

function validContext(value: unknown): value is ResponseContext {
  if (!isJsonObject(value) || !isJsonArray(value.requestInput) || !isJsonArray(value.responseOutput)) return false
  return (
    typeof value.responseId === "string" &&
    (typeof value.sessionId === "string" || value.sessionId === null) &&
    (typeof value.sourceInteractionId === "string" || value.sourceInteractionId === null) &&
    (typeof value.parentResponseId === "string" || value.parentResponseId === null) &&
    typeof value.imported === "boolean" &&
    (typeof value.label === "string" || value.label === null) &&
    (isJsonObject(value.provider) || value.provider === null) &&
    (typeof value.logId === "string" || value.logId === null) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  )
}

function startsWithItems(items: JsonArray, prefix: JsonArray): boolean {
  if (prefix.length > items.length) return false
  return prefix.every((item, index) => JSON.stringify(item) === JSON.stringify(items[index]))
}

export { ResponseContextStore }
