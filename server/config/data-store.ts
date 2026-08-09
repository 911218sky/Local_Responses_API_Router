import * as fs from "node:fs"
import * as path from "node:path"
import {
  type CodexProfile,
  type DashboardAuth,
  errorMessage,
  objectFromUnknown,
  type Provider,
  type RouterConfig,
} from "../core/types"
import { RouterDatabase } from "../storage/sqlite-store"

const appData =
  process.env.CODEX_ROUTER_DATA_DIR || path.join(process.env.APPDATA || process.cwd(), "CodexRouterDashboard")
const configPath = path.join(appData, "config.json")
const database = new RouterDatabase(appData)

const DEFAULT_CONFIG: RouterConfig = {
  dashboardPort: port(process.env.CODEX_ROUTER_DASHBOARD_PORT, 38127),
  routerPort: port(process.env.CODEX_ROUTER_ROUTER_PORT, 38128),
  openBrowserOnLaunch: true,
  startRouterOnLaunch: false,
  forwardEnabled: true,
  transformEnabled: true,
  recordLogs: false,
  persistResponseContexts: true,
  clearLogsOnShutdown: true,
  retryCount: 2,
  capacityRetryCount: 5,
  retryDelayMs: 800,
  activeRequestTimeoutMs: 300000,
  dashboardAuth: {
    enabled: false,
    username: "",
    passwordHash: "",
  },
  codexProfile: {
    userAgent: "Codex Desktop/0.146.0-alpha.3.1 (Windows 10.0.26200; x86_64) unknown (Codex Desktop; 26.721.41059)",
    originator: "Codex Desktop",
    betaFeatures: "remote_compaction_v2",
    responsesLite: true,
    sendUserAgent: true,
    sendOriginator: true,
    sendBetaFeatures: true,
    sendResponsesLite: true,
  },
  providers: [],
}

function ensureDataDirectory(): void {
  fs.mkdirSync(appData, { recursive: true })
}

function loadConfig(): RouterConfig {
  ensureDataDirectory()
  database.migrate("config-json-v1", () => database.saveSetting("config", readLegacyConfig()))
  const config = normalizeConfig(database.setting("config"))
  database.saveSetting("config", config)
  return config
}

function saveConfig(config: unknown): RouterConfig {
  ensureDataDirectory()
  const normalized = normalizeConfig(config)
  database.saveSetting("config", normalized)
  return normalized
}

function readLegacyConfig(): unknown {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"))
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      console.warn(`Unable to import legacy configuration: ${errorMessage(error)}`)
    }
    return DEFAULT_CONFIG
  }
}

function normalizeConfig(value: unknown): RouterConfig {
  // Environment variables take precedence so Docker deployments remain reproducible.
  const raw = objectFromUnknown(value)
  const rawProfile = objectFromUnknown(raw.codexProfile)
  const rawAuth = objectFromUnknown(raw.dashboardAuth)
  const rawProviders = Array.isArray(raw.providers) ? raw.providers : []
  const merged = {
    ...DEFAULT_CONFIG,
    dashboardPort: port(process.env.CODEX_ROUTER_DASHBOARD_PORT || raw.dashboardPort, DEFAULT_CONFIG.dashboardPort),
    routerPort: port(process.env.CODEX_ROUTER_ROUTER_PORT || raw.routerPort, DEFAULT_CONFIG.routerPort),
    openBrowserOnLaunch: booleanOr(raw.openBrowserOnLaunch, DEFAULT_CONFIG.openBrowserOnLaunch),
    startRouterOnLaunch: booleanFromEnv(
      process.env.CODEX_ROUTER_START_ROUTER_ON_LAUNCH,
      booleanOr(raw.startRouterOnLaunch, DEFAULT_CONFIG.startRouterOnLaunch),
    ),
    forwardEnabled: booleanOr(raw.forwardEnabled, DEFAULT_CONFIG.forwardEnabled),
    transformEnabled: booleanOr(raw.transformEnabled, DEFAULT_CONFIG.transformEnabled),
    recordLogs: booleanOr(raw.recordLogs, DEFAULT_CONFIG.recordLogs),
    persistResponseContexts: booleanOr(raw.persistResponseContexts, DEFAULT_CONFIG.persistResponseContexts),
    clearLogsOnShutdown: booleanOr(raw.clearLogsOnShutdown, DEFAULT_CONFIG.clearLogsOnShutdown),
    retryCount: integer(raw.retryCount, 0, 100, DEFAULT_CONFIG.retryCount),
    capacityRetryCount: integer(raw.capacityRetryCount, 0, 100, DEFAULT_CONFIG.capacityRetryCount),
    retryDelayMs: integer(raw.retryDelayMs, 100, 30000, DEFAULT_CONFIG.retryDelayMs),
    activeRequestTimeoutMs: integer(raw.activeRequestTimeoutMs, 1000, 3600000, DEFAULT_CONFIG.activeRequestTimeoutMs),
    codexProfile: normalizeProfile(rawProfile),
    dashboardAuth: normalizeDashboardAuth(rawAuth),
    providers: rawProviders.map(normalizeProvider),
  }
  return merged
}

function normalizeProfile(value: Record<string, unknown>): CodexProfile {
  return {
    userAgent: stringOr(value.userAgent, DEFAULT_CONFIG.codexProfile.userAgent),
    originator: stringOr(value.originator, DEFAULT_CONFIG.codexProfile.originator),
    betaFeatures: stringOr(value.betaFeatures, DEFAULT_CONFIG.codexProfile.betaFeatures),
    responsesLite: value.responsesLite !== false,
    sendUserAgent: value.sendUserAgent !== false,
    sendOriginator: value.sendOriginator !== false,
    sendBetaFeatures: value.sendBetaFeatures !== false,
    sendResponsesLite: value.sendResponsesLite !== false,
  }
}

function normalizeDashboardAuth(value: unknown): DashboardAuth {
  const raw = objectFromUnknown(value)
  return {
    enabled: raw.enabled === true,
    username: stringOr(raw.username).trim(),
    passwordHash: stringOr(raw.passwordHash),
  }
}

function normalizeProvider(value: unknown): Provider {
  const provider = objectFromUnknown(value)
  const slug = stringOr(provider.slug)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^-+|-+$/g, "")
  return {
    id: stringOr(provider.id, slug || String(Date.now())),
    slug,
    name: stringOr(provider.name, slug || "Unnamed provider").trim(),
    baseUrl: stringOr(provider.baseUrl).trim().replace(/\/$/, ""),
    enabled: provider.enabled !== false,
    routeOnly: provider.routeOnly === true,
  }
}

function stringOr(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function booleanFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return value.toLowerCase() === "true" ? true : value.toLowerCase() === "false" ? false : fallback
}

function port(value: unknown, fallback: number): number {
  const result = Number(value)
  return Number.isInteger(result) && result > 0 && result < 65536 ? result : fallback
}

function integer(value: unknown, min: number, max: number, fallback: number): number {
  const result = Number(value)
  return Number.isInteger(result) && result >= min && result <= max ? result : fallback
}

export { appData, database, loadConfig, normalizeConfig, normalizeProvider, saveConfig }
