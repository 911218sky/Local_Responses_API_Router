import type * as http from "node:http"
import type { Headers, JsonObject, Provider, PublicProvider, Usage } from "../core/types"
import { isJsonArray, isJsonObject } from "../core/types"

const MAX_RETRY_RESPONSE_BYTES = 5 * 1024 * 1024

export function isResponsesPath(path: string): boolean {
  const queryStart = path.indexOf("?")
  const pathname = queryStart >= 0 ? path.slice(0, queryStart) : path
  return pathname === "/responses" || pathname.startsWith("/responses/")
}

export function readResponseBody(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let byteCount = 0
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      callback()
    }
    stream.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      byteCount += buffer.length
      if (byteCount > MAX_RETRY_RESPONSE_BYTES) {
        stream.resume()
        finish(() => reject(new Error(`Upstream error response exceeded ${MAX_RETRY_RESPONSE_BYTES} bytes.`)))
        return
      }
      chunks.push(buffer)
    })
    stream.once("end", () => finish(() => resolve(Buffer.concat(chunks))))
    stream.once("close", () => finish(() => reject(new Error("Upstream response closed before completion."))))
    stream.once("error", (error) => finish(() => reject(error)))
  })
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export function tryJson(buffer: Buffer | string): JsonObject {
  const text = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : buffer
  try {
    const parsed: unknown = JSON.parse(text)
    if (isJsonObject(parsed)) return parsed
    if (isJsonArray(parsed)) return { value: parsed }
    if (parsed === null || typeof parsed === "boolean" || typeof parsed === "number" || typeof parsed === "string")
      return { value: parsed }
    return { raw: String(parsed) }
  } catch {
    return { raw: text }
  }
}

export function getUpstreamError(response: JsonObject): { readonly message: string; readonly code: string | null } {
  const error = response.error
  if (isJsonObject(error)) {
    return {
      message: typeof error.message === "string" ? error.message : "Upstream request failed.",
      code: typeof error.code === "string" ? error.code : null,
    }
  }
  if (typeof error === "string") return { message: error, code: null }
  return {
    message: typeof response.message === "string" ? response.message : "Upstream request failed.",
    code: response.code === undefined ? null : String(response.code),
  }
}

export function isCapacityError(message: string): boolean {
  return /selected\s+model\s+is\s+at\s+capacity(?:\.\s*|\s+)please\s+try\s+a\s+different\s+model\.?/i.test(
    message.trim(),
  )
}

export function usageFrom(value: unknown): Usage | undefined {
  if (!isJsonObject(value)) return undefined
  const inputTokens = numberValue(value.input_tokens)
  const outputTokens = numberValue(value.output_tokens)
  const promptTokens = numberValue(value.prompt_tokens)
  const completionTokens = numberValue(value.completion_tokens)
  const cachedTokens = numberValue(value.cached_tokens)
  const cachedInputTokens = isJsonObject(value.input_tokens_details)
    ? numberValue(value.input_tokens_details.cached_tokens)
    : undefined
  return {
    ...(inputTokens === undefined ? {} : { input_tokens: inputTokens }),
    ...(outputTokens === undefined ? {} : { output_tokens: outputTokens }),
    ...(promptTokens === undefined ? {} : { prompt_tokens: promptTokens }),
    ...(completionTokens === undefined ? {} : { completion_tokens: completionTokens }),
    ...(cachedTokens === undefined ? {} : { cached_tokens: cachedTokens }),
    ...(cachedInputTokens === undefined ? {} : { input_tokens_details: { cached_tokens: cachedInputTokens } }),
  }
}

export function parseSse(block: string): JsonObject | null {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
  if (!data || data === "[DONE]") return null
  try {
    const parsed: unknown = JSON.parse(data)
    return isJsonObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function publicProvider(provider: Provider): PublicProvider {
  return {
    id: provider.id,
    slug: provider.slug,
    name: provider.name,
    baseUrl: redactUrlCredentials(provider.baseUrl),
    enabled: provider.enabled,
    routeOnly: provider.routeOnly,
  }
}

export function resolveSessionId(headers: Headers, provider: Provider): string {
  return headerValue(headers["x-interaction-id"]) || headerValue(headers["session-id"]) || `unscoped:${provider.slug}`
}

export function redactHeaders(headers: Headers): Headers {
  const result: Headers = { ...headers }
  for (const key of Object.keys(result)) {
    if (["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key"].includes(key.toLowerCase()))
      result[key] = "[REDACTED]"
  }
  return result
}

export function redactUrlCredentials(value: string): string {
  try {
    const url = new URL(value)
    url.username = ""
    url.password = ""
    return url.toString().replace(/\/$/, "")
  } catch {
    return "[invalid upstream URL]"
  }
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(body))
}

export function headerValue(value: Headers[string]): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value === undefined ? undefined : String(value)
}

export function errorCode(error: unknown): string | null {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null
}

export function errorStatus(error: unknown): number | null {
  return error instanceof Error && "statusCode" in error && typeof error.statusCode === "number"
    ? error.statusCode
    : null
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined
}
