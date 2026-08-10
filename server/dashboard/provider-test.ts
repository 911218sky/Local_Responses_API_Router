import { createError } from "h3"

export type ProviderTestProtocol = "openai" | "anthropic" | "gemini" | "ollama"

export interface ProviderTestPreset {
  readonly id: string
  readonly name: string
  readonly baseUrl: string
  readonly protocol: ProviderTestProtocol
  readonly apiKeyRequired: boolean
  readonly description: string
}

export interface ProviderTestError {
  readonly code:
    | "invalid_input"
    | "invalid_key"
    | "invalid_base_url"
    | "model_not_found"
    | "timeout"
    | "unavailable"
    | "upstream_error"
  readonly message: string
  readonly status?: number
}

const CUSTOM_PRESET: ProviderTestPreset = {
  id: "custom",
  name: "Custom provider",
  baseUrl: "",
  protocol: "openai",
  apiKeyRequired: true,
  description: "Any OpenAI-compatible /v1 endpoint",
}

export const PROVIDER_TEST_PRESETS: readonly ProviderTestPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    protocol: "openai",
    apiKeyRequired: true,
    description: "GPT models and OpenAI-compatible Responses/Chat APIs",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    protocol: "anthropic",
    apiKeyRequired: true,
    description: "Claude models",
  },
  {
    id: "google",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    protocol: "gemini",
    apiKeyRequired: true,
    description: "Gemini models through the Google Generative Language API",
  },
  {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    protocol: "openai",
    apiKeyRequired: true,
    description: "Fast OpenAI-compatible inference",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    protocol: "openai",
    apiKeyRequired: true,
    description: "One API for many model providers",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    protocol: "openai",
    apiKeyRequired: true,
    description: "DeepSeek chat models",
  },
  {
    id: "mistral",
    name: "Mistral AI",
    baseUrl: "https://api.mistral.ai/v1",
    protocol: "openai",
    apiKeyRequired: true,
    description: "Mistral open and commercial models",
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    baseUrl: "http://127.0.0.1:11434",
    protocol: "ollama",
    apiKeyRequired: false,
    description: "Models running on a local Ollama server",
  },
  CUSTOM_PRESET,
]

const DEFAULT_TIMEOUT_MS = 20_000
const ANTHROPIC_VERSION = "2023-06-01"

export function getProviderTestPreset(id: unknown): ProviderTestPreset {
  const preset = PROVIDER_TEST_PRESETS.find((item) => item.id === id)
  return preset ?? CUSTOM_PRESET
}

export async function listProviderModels(input: unknown): Promise<{ models: string[] }> {
  const request = parseInput(input, "models")
  const response = await requestUpstream(request, "models")
  const body = await readJson(response)
  const models = extractModels(request.protocol, body)
  if (!models.length) throw safeError("model_not_found", "The provider returned no usable models.", response.status)
  return { models }
}

export async function sendProviderTestMessage(input: unknown): Promise<{ model: string; answer: string }> {
  const request = parseInput(input, "message")
  const model = requiredString(request.body.model, "A model is required.")
  const prompt = requiredString(request.body.prompt, "A test question is required.")
  const target = targetFor(request, "message", model)
  const response = await fetchWithTimeout(
    target,
    {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(messageBody(request.protocol, model, prompt)),
    },
    request.timeoutMs,
  )
  const body = await readJson(response)
  if (!response.ok) throw classifyResponse(response.status, "message")
  const answer = extractAnswer(request.protocol, body)
  if (!answer) throw safeError("upstream_error", "The provider returned an empty answer.", response.status)
  return { model, answer }
}

interface TestRequest {
  readonly protocol: ProviderTestProtocol
  readonly baseUrl: string
  readonly apiKey: string
  readonly headers: Record<string, string>
  readonly timeoutMs: number
  readonly body: Record<string, unknown>
}

function parseInput(value: unknown, operation: "models" | "message"): TestRequest {
  const raw = isRecord(value) ? value : {}
  const preset = getProviderTestPreset(raw.presetId)
  const baseUrl = stringValue(raw.baseUrl).trim() || preset.baseUrl
  const apiKey = stringValue(raw.apiKey).trim()
  if (!baseUrl) throw safeError("invalid_base_url", "Enter an API Base URL before testing the provider.")
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw safeError("invalid_base_url", "The API Base URL is not a valid URL.")
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw safeError("invalid_base_url", "The API Base URL must begin with http:// or https://.")
  if (preset.apiKeyRequired && !apiKey) throw safeError("invalid_key", "Enter an API Key before testing the provider.")
  const timeoutSeconds = Number(raw.timeoutSeconds)
  const timeoutMs =
    Number.isFinite(timeoutSeconds) && timeoutSeconds >= 5 && timeoutSeconds <= 120
      ? Math.round(timeoutSeconds * 1000)
      : DEFAULT_TIMEOUT_MS
  return {
    protocol: preset.protocol,
    baseUrl: parsed.toString().replace(/\/$/, ""),
    apiKey,
    headers: authHeaders(preset.protocol, apiKey, operation),
    timeoutMs,
    body: raw,
  }
}

function targetFor(request: TestRequest, operation: "models" | "message", model = ""): string {
  if (request.protocol === "gemini") {
    const modelName = model.replace(/^models\//, "")
    return `${request.baseUrl}/models/${operation === "models" ? "" : `${encodeURIComponent(modelName)}:generateContent`}${request.apiKey ? `?key=${encodeURIComponent(request.apiKey)}` : ""}`.replace(
      "/models/?",
      "/models?",
    )
  }
  if (request.protocol === "ollama") return `${request.baseUrl}/api/${operation === "models" ? "tags" : "chat"}`
  return `${request.baseUrl}/${request.protocol === "anthropic" ? "models" : operation === "models" ? "models" : "chat/completions"}`
}

function authHeaders(
  protocol: ProviderTestProtocol,
  apiKey: string,
  operation: "models" | "message",
): Record<string, string> {
  if (protocol === "anthropic")
    return { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION }
  if (protocol === "gemini" || protocol === "ollama") return { "content-type": "application/json" }
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    ...(operation === "message" ? { "user-agent": "Codex-Router-Provider-Test" } : {}),
  }
}

async function requestUpstream(request: TestRequest, operation: "models" | "message"): Promise<Response> {
  const response = await fetchWithTimeout(
    targetFor(request, operation),
    { headers: request.headers },
    request.timeoutMs,
  )
  if (!response.ok) throw classifyResponse(response.status, operation)
  return response
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: "manual" })
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError")
      throw safeError("timeout", "The request timed out. Check the provider URL or try again.")
    throw safeError("unavailable", "The provider could not be reached. Check the Base URL and network connection.")
  } finally {
    clearTimeout(timer)
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function extractModels(protocol: ProviderTestProtocol, body: unknown): string[] {
  const raw = isRecord(body) ? body : {}
  if (protocol === "ollama")
    return arrayOfRecords(raw.models)
      .map((item) => stringValue(item.name))
      .filter(Boolean)
  const data = Array.isArray(raw.data) ? raw.data : protocol === "gemini" && Array.isArray(raw.models) ? raw.models : []
  return data
    .map((item) => {
      const record = isRecord(item) ? item : {}
      return stringValue(record.id || record.name).replace(/^models\//, "")
    })
    .filter(Boolean)
}

function messageBody(protocol: ProviderTestProtocol, model: string, prompt: string): Record<string, unknown> {
  if (protocol === "anthropic") return { model, max_tokens: 512, messages: [{ role: "user", content: prompt }] }
  if (protocol === "gemini") return { contents: [{ role: "user", parts: [{ text: prompt }] }] }
  if (protocol === "ollama") return { model, messages: [{ role: "user", content: prompt }], stream: false }
  return { model, messages: [{ role: "user", content: prompt }], stream: false }
}

function extractAnswer(protocol: ProviderTestProtocol, body: unknown): string {
  const raw = isRecord(body) ? body : {}
  if (protocol === "anthropic")
    return arrayOfRecords(raw.content)
      .map((item) => stringValue(item.text))
      .filter(Boolean)
      .join("\n")
      .trim()
  if (protocol === "gemini") {
    const candidates = Array.isArray(raw.candidates) ? raw.candidates : []
    const firstCandidate = isRecord(candidates[0]) ? candidates[0] : null
    const content = firstCandidate && isRecord(firstCandidate.content) ? firstCandidate.content : null
    return arrayOfRecords(content?.parts)
      .map((part) => stringValue(part.text))
      .filter(Boolean)
      .join("\n")
      .trim()
  }
  if (protocol === "ollama") return stringValue(isRecord(raw.message) ? raw.message.content : raw.response).trim()
  const choice = Array.isArray(raw.choices) && isRecord(raw.choices[0]) ? raw.choices[0] : {}
  return stringValue(isRecord(choice.message) ? choice.message.content : choice.text).trim()
}

function classifyResponse(status: number, operation: "models" | "message"): Error {
  if (status === 401 || status === 403)
    return safeError("invalid_key", "The API Key was rejected by the provider.", status)
  if (status === 404)
    return safeError(
      operation === "models" ? "invalid_base_url" : "model_not_found",
      operation === "models"
        ? "The provider Base URL does not expose a model endpoint."
        : "The selected model was not found at this provider.",
      status,
    )
  if (status === 408 || status === 504) return safeError("timeout", "The provider request timed out.", status)
  if (status === 429 || status >= 500)
    return safeError(
      "unavailable",
      "The provider is temporarily unavailable or rate limited. Try again shortly.",
      status,
    )
  return safeError(
    "upstream_error",
    `The provider returned an error while ${operation === "models" ? "listing models" : "answering the test question"}.`,
    status,
  )
}

function safeError(code: ProviderTestError["code"], message: string, status?: number): Error {
  const error = createError({
    statusCode: status && status >= 400 && status < 600 ? status : 502,
    statusMessage: message,
    data: { code, message },
  })
  return error
}

function requiredString(value: unknown, message: string): string {
  const result = stringValue(value).trim()
  if (!result) throw safeError("invalid_input", message)
  return result
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : []
}
