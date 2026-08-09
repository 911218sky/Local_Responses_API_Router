export interface Provider {
  id: string
  slug: string
  name: string
  baseUrl: string
  enabled: boolean
  routeOnly: boolean
}

export interface RouterStatus {
  running: boolean
  port: number
  startedAt: string | null
  routeFormat: string
  activeRequests: ActiveRequest[]
}

export interface ActiveRequest {
  id: string
  provider?: Provider
  method: string
  path: string
  status: string
  startedAt: string
  elapsedMs: number
  sessionId?: string | null
  sourceInteractionId?: string | null
  logId?: string | null
}

export interface RouterConfig {
  dashboardPort: number
  routerPort: number
  openBrowserOnLaunch: boolean
  startRouterOnLaunch: boolean
  forwardEnabled: boolean
  transformEnabled: boolean
  recordLogs: boolean
  persistResponseContexts: boolean
  clearLogsOnShutdown: boolean
  retryCount: number
  capacityRetryCount: number
  retryDelayMs: number
  activeRequestTimeoutMs: number
  dashboardAuth: { enabled: boolean; username: string }
  codexProfile: {
    userAgent: string
    originator: string
    betaFeatures: string
    responsesLite: boolean
    sendUserAgent: boolean
    sendOriginator: boolean
    sendBetaFeatures: boolean
    sendResponsesLite: boolean
  }
  providers: Provider[]
}

export interface RequestLog {
  id: string
  createdAt: string
  completedAt?: string
  status: string
  provider?: Provider
  sessionId?: string
  path?: string
  responseStatus?: number
  durationMs?: number
  error?: string
  usage?: Record<string, unknown>
  transformMode?: string
  inbound?: Record<string, unknown>
  outbound?: Record<string, unknown>
  response?: Record<string, unknown>
  transform?: {
    mode: "continuation" | "initial" | "passthrough"
    operations: Array<{ type: string; scope: string; label: string; from?: string; to?: string }>
  }
}

export interface Session {
  sessionId: string | null
  provider: Provider | null | undefined
  label: string | null
  imported: boolean
  count: number
  updatedAt: string
  responseIds: string[]
  requestCount?: number
}

export interface SessionContextSummary {
  responseId: string
  sessionId: string | null
  sourceInteractionId: string | null
  parentResponseId: string | null
  imported: boolean
  label: string | null
  provider: Provider | null
  logId: string | null
  createdAt: string
  updatedAt: string
  inputItemCount: number
  outputItemCount: number
}

export interface SessionReplay {
  context: SessionContextSummary
  history: unknown[]
}

export interface SessionDetail extends Session {
  logs: RequestLog[]
  contexts: SessionContextSummary[]
  replay: SessionReplay | null
}

export interface DashboardState {
  config: RouterConfig
  router: RouterStatus
  logging: boolean
  sessions: Session[]
  missingContinuations: Array<{ responseId: string; createdAt: string; provider?: Provider; logId: string }>
}
