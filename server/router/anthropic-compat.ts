import { isJsonArray, isJsonObject, type JsonArray, type JsonObject } from "../core/types"

export interface AnthropicRequest {
  readonly model: string
  readonly stream: boolean
  readonly request: JsonObject
}

export function anthropicToResponses(value: JsonObject): AnthropicRequest {
  const model = stringValue(value.model)
  if (!model) throw new AnthropicCompatibilityError("model is required.")
  if (!isJsonArray(value.messages)) throw new AnthropicCompatibilityError("messages must be an array.")

  const input: JsonArray = []
  appendSystem(input, value.system)
  for (const message of value.messages) appendMessage(input, message)

  const tools = isJsonArray(value.tools) ? value.tools.map(toResponsesTool) : []
  const selectedTool = toolChoice(value.tool_choice)
  const reasoning = responsesReasoning(value.output_config)
  const request: JsonObject = {
    model,
    input,
    stream: value.stream === true,
    ...(tools.length ? { tools } : {}),
    ...(selectedTool ? { tool_choice: selectedTool } : {}),
    ...(reasoning ? { reasoning } : {}),
  }
  return { model, stream: value.stream === true, request }
}

export function responsesToAnthropic(response: JsonObject, requestedModel: string): JsonObject {
  const output = isJsonArray(response.output) ? response.output : []
  const content: JsonArray = []
  for (const item of output) appendResponseItem(content, item)
  const hasToolUse = content.some((item) => isJsonObject(item) && item.type === "tool_use")
  return {
    id: stringValue(response.id) || "msg_router_response",
    type: "message",
    role: "assistant",
    model: stringValue(response.model) || requestedModel,
    content,
    stop_reason: hasToolUse ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: anthropicUsage(response.usage),
  }
}

export function anthropicError(status: number, body: JsonObject): JsonObject {
  const upstream = isJsonObject(body.error) ? body.error : body
  return {
    type: "error",
    error: {
      type:
        status === 401 || status === 403 ? "authentication_error" : status === 429 ? "rate_limit_error" : "api_error",
      message: stringValue(upstream.message) || "Upstream request failed.",
    },
  }
}

export class AnthropicCompatibilityError extends Error {
  readonly statusCode = 400
}

function appendSystem(input: JsonArray, value: unknown): void {
  if (typeof value === "string" && value) input.push(messageItem("system", [{ type: "input_text", text: value }]))
  else if (isJsonArray(value)) input.push(messageItem("system", contentBlocks(value, "system")))
}

function appendMessage(input: JsonArray, raw: unknown): void {
  if (!isJsonObject(raw)) throw new AnthropicCompatibilityError("Each message must be an object.")
  const role = stringValue(raw.role)
  if (role !== "system" && role !== "user" && role !== "assistant")
    throw new AnthropicCompatibilityError(`Unsupported message role: ${role || "unknown"}.`)
  const content = typeof raw.content === "string" ? [{ type: "text", text: raw.content }] : raw.content
  if (!isJsonArray(content)) throw new AnthropicCompatibilityError("Message content must be a string or an array.")
  input.push(messageItem(role, contentBlocks(content, role)))
}

function messageItem(role: string, content: JsonArray): JsonObject {
  return { type: "message", role, content }
}

function contentBlocks(blocks: JsonArray, role: string): JsonArray {
  const result: JsonArray = []
  for (const raw of blocks) {
    if (!isJsonObject(raw)) throw new AnthropicCompatibilityError("Message content blocks must be objects.")
    const type = stringValue(raw.type)
    if (type === "text") {
      result.push({ type: role === "assistant" ? "output_text" : "input_text", text: stringValue(raw.text) })
      continue
    }
    if (type === "tool_use" && role === "assistant") {
      result.push({
        type: "function_call",
        call_id: stringValue(raw.id),
        name: stringValue(raw.name),
        arguments: JSON.stringify(isJsonObject(raw.input) ? raw.input : {}),
      })
      continue
    }
    if (type === "tool_result" && role === "user") {
      result.push({
        type: "function_call_output",
        call_id: stringValue(raw.tool_use_id),
        output: toolOutput(raw.content),
      })
      continue
    }
    throw new AnthropicCompatibilityError(`Unsupported ${type || "unknown"} content block.`)
  }
  return result
}

function toolOutput(value: unknown): string {
  if (typeof value === "string") return value
  if (!isJsonArray(value)) return ""
  return value
    .filter(isJsonObject)
    .filter((item) => item.type === "text")
    .map((item) => stringValue(item.text))
    .join("\n")
}

function toResponsesTool(raw: unknown): JsonObject {
  if (!isJsonObject(raw) || !stringValue(raw.name)) throw new AnthropicCompatibilityError("Each tool requires a name.")
  return {
    type: "function",
    name: stringValue(raw.name),
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    parameters: isJsonObject(raw.input_schema) ? raw.input_schema : { type: "object", properties: {} },
  }
}

function toolChoice(value: unknown): JsonObject | undefined {
  if (!isJsonObject(value)) return undefined
  if (value.type === "any") return { type: "required" }
  if (value.type === "tool" && stringValue(value.name)) return { type: "function", name: stringValue(value.name) }
  return undefined
}

function responsesReasoning(value: unknown): JsonObject | undefined {
  if (!isJsonObject(value)) return undefined
  const effort = stringValue(value.effort)
  if (!effort) return undefined
  return { effort }
}

function appendResponseItem(content: JsonArray, raw: unknown): void {
  if (!isJsonObject(raw)) return
  if (raw.type === "message" && isJsonArray(raw.content)) {
    for (const block of raw.content) {
      if (isJsonObject(block) && block.type === "output_text")
        content.push({ type: "text", text: stringValue(block.text) })
    }
  }
  if (raw.type === "function_call") {
    let input: JsonObject = {}
    try {
      const parsed: unknown = JSON.parse(stringValue(raw.arguments) || "{}")
      if (isJsonObject(parsed)) input = parsed
    } catch {}
    content.push({
      type: "tool_use",
      id: stringValue(raw.call_id) || stringValue(raw.id),
      name: stringValue(raw.name),
      input,
    })
  }
}

function anthropicUsage(value: unknown): JsonObject {
  if (!isJsonObject(value)) return { input_tokens: 0, output_tokens: 0 }
  return { input_tokens: numberValue(value.input_tokens), output_tokens: numberValue(value.output_tokens) }
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : 0
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : ""
}
