export type JsonPrimitive = boolean | null | number | string
export type JsonValue = JsonArray | JsonObject | JsonPrimitive
export type JsonArray = JsonValue[]
export type JsonObject = { [key: string]: JsonValue }

export type HeaderValue = number | string | string[] | undefined
export type Headers = Record<string, HeaderValue>

export interface Provider {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly baseUrl: string
  readonly enabled: boolean
  readonly routeOnly: boolean
}

export interface DashboardAuth {
  readonly enabled: boolean
  readonly username: string
  readonly passwordHash: string
}

export interface CodexProfile {
  readonly userAgent: string
  readonly originator: string
  readonly betaFeatures: string
  readonly responsesLite: boolean
  readonly sendUserAgent: boolean
  readonly sendOriginator: boolean
  readonly sendBetaFeatures: boolean
  readonly sendResponsesLite: boolean
}

export interface RouterConfig {
  readonly dashboardPort: number
  readonly routerPort: number
  readonly openBrowserOnLaunch: boolean
  readonly startRouterOnLaunch: boolean
  readonly forwardEnabled: boolean
  readonly transformEnabled: boolean
  readonly recordLogs: boolean
  readonly persistResponseContexts: boolean
  readonly clearLogsOnShutdown: boolean
  readonly retryCount: number
  readonly capacityRetryCount: number
  readonly retryDelayMs: number
  readonly activeRequestTimeoutMs: number
  readonly dashboardAuth: DashboardAuth
  readonly codexProfile: CodexProfile
  readonly providers: Provider[]
}

export interface PublicProvider {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly baseUrl: string
  readonly enabled: boolean
  readonly routeOnly: boolean
}

export type PublicDashboardAuth = Omit<DashboardAuth, "passwordHash">

export type PublicRouterConfig = Omit<RouterConfig, "dashboardAuth" | "providers"> & {
  readonly dashboardAuth: PublicDashboardAuth
  readonly providers: readonly PublicProvider[]
}

export interface TransformOperation {
  readonly type: "added" | "passed" | "removed" | "transformed"
  readonly scope: "body" | "headers" | "routing"
  readonly from?: string
  readonly to?: string
  readonly label: string
}

export interface ContinuationTrace {
  readonly previousResponseId: string
  readonly outcome: "restored"
  readonly historyItemCount: number
  historyStartIndex: number
  readonly persisted: boolean
  readonly sourceInteractionId: string
  readonly sessionId: string
}

export interface TransformTrace {
  mode: "continuation" | "initial" | "passthrough"
  operations: TransformOperation[]
  continuation?: ContinuationTrace
}

export interface ResponseContextMetadata {
  readonly sessionId?: string | null
  readonly sourceInteractionId?: string | null
  readonly parentResponseId?: string | null
  readonly imported?: boolean
  readonly label?: string | null
  readonly provider?: PublicProvider | Provider | null
  readonly logId?: string | null
}

export interface ResponseContext {
  readonly responseId: string
  sessionId: string | null
  sourceInteractionId: string | null
  parentResponseId: string | null
  imported: boolean
  label: string | null
  provider: PublicProvider | Provider | null
  logId: string | null
  readonly createdAt: string
  readonly updatedAt: string
  requestInput: JsonArray
  responseOutput: JsonArray
}

export interface ResponseContextSummary {
  readonly responseId: string
  readonly sessionId: string | null
  readonly sourceInteractionId: string | null
  readonly parentResponseId: string | null
  readonly imported: boolean
  readonly label: string | null
  readonly provider: PublicProvider | Provider | null
  readonly logId: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly inputItemCount: number
  readonly outputItemCount: number
}

export interface SessionSummary {
  readonly sessionId: string | null
  readonly provider: PublicProvider | Provider | null
  label: string | null
  imported: boolean
  count: number
  updatedAt: string
  readonly responseIds: string[]
}

export interface Usage {
  readonly input_tokens?: number
  readonly output_tokens?: number
  readonly prompt_tokens?: number
  readonly completion_tokens?: number
  readonly cached_tokens?: number
  readonly input_tokens_details?: {
    readonly cached_tokens?: number
  }
}

export interface RequestLog {
  readonly id: string
  readonly createdAt: string
  completedAt?: string
  status: string
  provider?: PublicProvider
  sessionId?: string
  sourceInteractionId?: string | null
  method?: string
  path?: string
  localUrl?: string
  responseStatus?: number
  durationMs?: number
  error?: string
  errorCode?: string | null
  errorOrigin?: string
  inbound?: Record<string, unknown>
  outbound?: Record<string, unknown>
  response?: Record<string, unknown>
  transform?: TransformTrace
  responseContext?: Record<string, unknown>
  usage?: Usage
  cacheComparison?: Record<string, unknown>
  target?: string
}

export interface RequestLogSummary {
  readonly id: string
  readonly createdAt: string
  readonly completedAt?: string
  readonly status: string
  readonly provider?: PublicProvider
  readonly sessionId?: string
  readonly sourceInteractionId?: string | null
  readonly method?: string
  readonly path?: string
  readonly responseStatus?: number
  readonly durationMs?: number
  readonly error?: string
  readonly usage?: Usage
  readonly cacheComparison?: Record<string, unknown>
  readonly transformMode?: TransformTrace["mode"]
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isJsonArray(value: unknown): value is JsonArray {
  return Array.isArray(value)
}

export function objectFromUnknown(value: unknown): Record<string, unknown> {
  return isUnknownRecord(value) ? value : {}
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function jsonString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
