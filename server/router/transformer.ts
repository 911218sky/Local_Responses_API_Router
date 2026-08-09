import * as crypto from "node:crypto"
import {
  type CodexProfile,
  type Headers,
  isJsonArray,
  isJsonObject,
  type JsonArray,
  type JsonObject,
  type ResponseContextMetadata,
  type TransformTrace,
} from "../core/types"
import type { ResponseContextStore } from "../storage/response-context"

// Keeps the installation identifier stable for the lifetime of this proxy process.
const installationId = generateUUID()

// Stores fully expanded HTTP history by upstream response id. This is required because
// Codex Responses Lite HTTP does not accept previous_response_id continuations.
const responseContextsById = new Map<string, JsonArray>()
const MAX_RESPONSE_CONTEXT_CACHE_ENTRIES = 500
const cacheSubscriptions = new WeakSet<ResponseContextStore>()

const DEFAULT_CODEX_PROFILE: CodexProfile = {
  userAgent: "Codex Desktop/0.146.0-alpha.3.1 (Windows 10.0.26200; x86_64) unknown (Codex Desktop; 26.721.41059)",
  originator: "Codex Desktop",
  betaFeatures: "remote_compaction_v2",
  responsesLite: true,
  sendUserAgent: true,
  sendOriginator: true,
  sendBetaFeatures: true,
  sendResponsesLite: true,
}

function generateUUID(): string {
  if (crypto.randomUUID) return crypto.randomUUID()
  return `019f9c83-45df-7400-b39b-${crypto.randomBytes(6).toString("hex")}`
}

function resolveProfile(profile: CodexProfile): CodexProfile {
  return { ...DEFAULT_CODEX_PROFILE, ...profile }
}

/**
 * Converts a Copilot Responses request into the same stateless HTTP envelope
 * emitted by Codex. Profile values are intentionally configurable, but no
 * machine-specific values are persisted in the source tree.
 */
function transformToCodex(
  incomingHeaders: Headers,
  incomingBody: Buffer | JsonObject,
  incomingPath: string | undefined,
  profile: CodexProfile,
  contextStore: ResponseContextStore,
): {
  readonly headers: Headers
  readonly body: Buffer
  readonly method: "POST"
  readonly path: string
  readonly trace: TransformTrace
  readonly request: JsonObject
  readonly sessionId: string
  readonly sourceInteractionId: string
  readonly previousResponseId: string | null
} {
  const activeProfile = resolveProfile(profile)
  bindResponseContextCache(contextStore)
  const bodyBuffer = toBuffer(incomingBody)
  let requestBody: JsonObject

  try {
    const parsed: unknown = JSON.parse(bodyBuffer.toString("utf8"))
    if (!isJsonObject(parsed)) throw new Error("The incoming request body must be a JSON object.")
    requestBody = parsed
  } catch (error) {
    throw new Error(
      `The incoming request body must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!isJsonArray(requestBody.input)) throw new Error("The incoming request body must contain an input array.")
  if (requestBody.tools !== undefined && !isJsonArray(requestBody.tools)) {
    throw new Error("The incoming request body tools field must be an array.")
  }
  const requestTools = isJsonArray(requestBody.tools) ? requestBody.tools : []

  const sourceInteractionId =
    headerString(incomingHeaders["x-interaction-id"]) ||
    headerString(incomingHeaders["session-id"]) ||
    headerString(incomingHeaders["x-agent-task-id"]) ||
    generateUUID()
  let sessionId = sourceInteractionId
  const requestId = headerString(incomingHeaders["x-client-request-id"]) || sourceInteractionId
  let threadId = headerString(incomingHeaders["thread-id"]) || sourceInteractionId
  const turnId = generateUUID()
  let windowId = `${sessionId}:0`
  const turnMetadata = {
    installation_id: installationId,
    session_id: sessionId,
    thread_id: threadId,
    turn_id: turnId,
    window_id: windowId,
    request_kind: "turn",
    thread_source: "user",
    sandbox: "none",
    turn_started_at_unix_ms: Date.now(),
    workspace_kind: "project",
  }

  const trace: TransformTrace = {
    mode: "initial",
    operations: [
      {
        type: "passed",
        scope: "headers",
        from: "headers.authorization",
        to: "headers.authorization",
        label: "Authentication forwarded unchanged",
      },
      { type: "transformed", scope: "routing", from: "path", to: "path", label: "Normalized to Codex Responses path" },
      { type: "added", scope: "headers", to: "headers.x-codex-turn-metadata", label: "Generated Codex turn metadata" },
      { type: "added", scope: "body", to: "body.client_metadata", label: "Added Codex client metadata" },
      { type: "removed", scope: "body", from: "body.previous_response_id", label: "Never sent on stateless HTTP" },
    ],
  }

  let codexInput: JsonArray
  if (typeof requestBody.previous_response_id === "string") {
    const stored = contextStore.get(requestBody.previous_response_id)
    const previousContext = stored
      ? contextStore.getHistory(requestBody.previous_response_id)
      : contextStore.shouldPersist()
        ? undefined
        : responseContextsById.get(requestBody.previous_response_id)
    if (previousContext) {
      sessionId = stored?.sessionId || sessionId
      threadId = stored?.sessionId || threadId
      codexInput = [...previousContext]
      trace.mode = "continuation"
      trace.continuation = {
        previousResponseId: requestBody.previous_response_id,
        outcome: "restored",
        historyItemCount: previousContext.length,
        historyStartIndex: 0,
        persisted: Boolean(stored),
        sourceInteractionId,
        sessionId,
      }
      trace.operations.push({
        type: "transformed",
        scope: "body",
        from: "body.previous_response_id",
        to: "body.input",
        label: `Expanded ${previousContext.length} history items for stateless HTTP continuation`,
      })
      if (requestTools.length && !codexInput.some((item) => isJsonObject(item) && item.type === "additional_tools")) {
        codexInput.unshift({ type: "additional_tools", role: "developer", tools: requestTools })
        trace.continuation.historyStartIndex = 1
        trace.operations.push({
          type: "added",
          scope: "body",
          to: "body.input[0].additional_tools",
          label: "Restored current tool declarations because imported history has none",
        })
      }
    } else {
      throw new MissingContinuationContextError(requestBody.previous_response_id)
    }
  } else {
    codexInput = requestBody.tools?.length
      ? [{ type: "additional_tools", role: "developer", tools: requestBody.tools }]
      : []
    if (requestBody.tools?.length) {
      trace.operations.push({
        type: "transformed",
        scope: "body",
        from: "body.tools",
        to: "body.input[0].additional_tools",
        label: "Moved tool declarations into Codex input",
      })
    }
  }

  for (const item of requestBody.input) {
    if (isJsonObject(item) && item.type === "function_call_output") {
      const hasMatchingCall = codexInput.some(
        (previousItem) =>
          isJsonObject(previousItem) &&
          (previousItem.type === "function_call" || previousItem.type === "custom_tool_call") &&
          previousItem.call_id === item.call_id,
      )
      if (!hasMatchingCall) throw new Error(`No local function-call item is available for call ${item.call_id}.`)
      codexInput.push(item)
      trace.operations.push({
        type: "passed",
        scope: "body",
        from: `body.input.function_call_output(${item.call_id})`,
        to: "body.input",
        label: "Appended tool result after matching historical call",
      })
      continue
    }

    if (isJsonObject(item) && item.role === "system") {
      codexInput.push({ ...item, role: "developer" })
      trace.operations.push({
        type: "transformed",
        scope: "body",
        from: "body.input.role=system",
        to: "body.input.role=developer",
        label: "Mapped system instruction to developer instruction",
      })
    } else {
      codexInput.push(item)
      trace.operations.push({
        type: "passed",
        scope: "body",
        from: "body.input",
        to: "body.input",
        label: `Forwarded ${isJsonObject(item) && typeof item.type === "string" ? item.type : "input"} item`,
      })
    }
  }

  windowId = `${sessionId}:0`
  turnMetadata.session_id = sessionId
  turnMetadata.thread_id = threadId
  turnMetadata.window_id = windowId
  const codexBody = {
    ...(requestBody.model === undefined ? {} : { model: requestBody.model }),
    input: codexInput,
    tool_choice: requestBody.tool_choice || "auto",
    parallel_tool_calls: requestBody.parallel_tool_calls === true,
    reasoning: requestBody.reasoning || { effort: "medium", summary: "detailed" },
    store: false,
    stream: requestBody.stream === true,
    include: requestBody.include || ["reasoning.encrypted_content"],
    prompt_cache_key: sessionId,
    text: requestBody.text || { verbosity: "low" },
    client_metadata: {
      "x-codex-installation-id": installationId,
      "x-codex-window-id": windowId,
      turn_id: turnId,
      session_id: sessionId,
      thread_id: threadId,
    },
  }
  trace.operations.push({
    type: "added",
    scope: "body",
    to: "body.store",
    label: "Forced false: continuation is reconstructed locally",
  })
  trace.operations.push({
    type: "added",
    scope: "body",
    to: "body.prompt_cache_key",
    label: "Stable interaction identifier for upstream cache",
  })

  const outputBuffer = Buffer.from(JSON.stringify(codexBody))
  const normalizedPath = normalizePath(incomingPath)
  const codexHeaders: Headers = {
    "content-length": String(outputBuffer.length),
    accept: "text/event-stream",
    ...(incomingHeaders.authorization ? { authorization: incomingHeaders.authorization } : {}),
    "content-type": "application/json",
    "session-id": sessionId,
    "thread-id": threadId,
    "x-client-request-id": requestId,
    "x-codex-turn-metadata": JSON.stringify(turnMetadata),
    "x-codex-window-id": windowId,
  }

  return {
    headers: applyCodexProfileHeaders(codexHeaders, activeProfile),
    body: outputBuffer,
    method: "POST",
    path: normalizedPath,
    trace,
    request: codexBody,
    sessionId,
    sourceInteractionId,
    previousResponseId: typeof requestBody.previous_response_id === "string" ? requestBody.previous_response_id : null,
  }
}

function applyCodexProfileHeaders(headers: Headers, profile: CodexProfile): Headers {
  const result: Headers = { ...headers }
  if (profile.sendUserAgent && profile.userAgent) result["user-agent"] = profile.userAgent
  else delete result["user-agent"]
  if (profile.sendOriginator && profile.originator) result.originator = profile.originator
  else delete result.originator
  if (profile.sendBetaFeatures && profile.betaFeatures) result["x-codex-beta-features"] = profile.betaFeatures
  else delete result["x-codex-beta-features"]
  if (profile.sendResponsesLite)
    result["x-openai-internal-codex-responses-lite"] = String(profile.responsesLite !== false)
  else delete result["x-openai-internal-codex-responses-lite"]
  return result
}

function toBuffer(value: Buffer | JsonObject): Buffer {
  if (Buffer.isBuffer(value)) return value
  if (typeof value === "object" && value !== null) return Buffer.from(JSON.stringify(value))
  return Buffer.from(value || "")
}

function normalizePath(incomingPath: string | undefined): string {
  try {
    const requestUrl = new URL(incomingPath || "/responses", "http://localhost")
    const pathname = requestUrl.pathname === "/v1/responses" ? "/responses" : requestUrl.pathname
    return pathname + requestUrl.search
  } catch (error) {
    throw new Error(`The incoming request path is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function recordResponseContext(
  responseId: string,
  requestInput: JsonArray,
  responseOutput: JsonArray,
  contextStore: ResponseContextStore,
  metadata: ResponseContextMetadata,
): void {
  if (!responseId || !Array.isArray(requestInput) || !Array.isArray(responseOutput)) {
    throw new Error("A response id, request input, and response output are required.")
  }
  bindResponseContextCache(contextStore)
  const history = [...requestInput, ...responseOutput]
  const previous = responseContextsById.get(responseId)
  if (previous && JSON.stringify(previous) === JSON.stringify(history) && contextStore.get(responseId)) return
  responseContextsById.delete(responseId)
  responseContextsById.set(responseId, history)
  trimResponseContextCache()
  contextStore.save(responseId, requestInput, responseOutput, metadata)
}

function resetResponseContexts(): void {
  responseContextsById.clear()
}

function responseContextCacheSize(): number {
  return responseContextsById.size
}

function bindResponseContextCache(contextStore: ResponseContextStore): void {
  if (cacheSubscriptions.has(contextStore)) return
  cacheSubscriptions.add(contextStore)
  contextStore.on("changed", (value: unknown) => {
    if (!isJsonObject(value)) return
    if (value.type === "cleared") {
      responseContextsById.clear()
      return
    }
    const context = isJsonObject(value.context) ? value.context : null
    if (value.type === "deleted" && typeof context?.responseId === "string") {
      responseContextsById.delete(context.responseId)
      return
    }
    if (value.type !== "deleted-many" || !isJsonArray(value.responseIds)) return
    for (const responseId of value.responseIds) {
      if (typeof responseId === "string") responseContextsById.delete(responseId)
    }
  })
}

function trimResponseContextCache(): void {
  while (responseContextsById.size > MAX_RESPONSE_CONTEXT_CACHE_ENTRIES) {
    const oldest = responseContextsById.keys().next().value
    if (typeof oldest !== "string") return
    responseContextsById.delete(oldest)
  }
}

function headerString(value: Headers[string]): string {
  if (Array.isArray(value)) return value[0] || ""
  return value === undefined ? "" : String(value)
}

class MissingContinuationContextError extends Error {
  readonly statusCode = 401
  readonly code = "missing_continuation_context"

  constructor(responseId: string) {
    super(
      `Continuation history for ${responseId} is not available. Import the Copilot session in the dashboard before retrying this request.`,
    )
  }
}

export {
  applyCodexProfileHeaders,
  DEFAULT_CODEX_PROFILE,
  recordResponseContext,
  resetResponseContexts,
  responseContextCacheSize,
  transformToCodex,
}
