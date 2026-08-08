import { appData, loadConfig, normalizeProvider, saveConfig } from "./backend/config/data-store"
import { objectFromUnknown, type RouterConfig } from "./backend/core/types"
import { updateDashboardAuth } from "./backend/dashboard/auth"
import { publicConfig, publicProvider, validateProvider } from "./backend/dashboard/providers"
import { listMissingContinuations, listSessions, reconcileStoredSessions } from "./backend/dashboard/sessions"
import { ProxyService } from "./backend/router/proxy-service"
import { importCopilotTranscript } from "./backend/router/transcript-importer"
import { RequestLogStore } from "./backend/storage/request-log"
import { ResponseContextStore } from "./backend/storage/response-context"

export class RouterRuntime {
  private config: RouterConfig
  readonly logs: RequestLogStore
  readonly contexts: ResponseContextStore
  readonly router: ProxyService

  constructor() {
    this.config = loadConfig()
    this.logs = new RequestLogStore(appData, () => this.config.recordLogs)
    this.contexts = new ResponseContextStore(appData, () => this.config.persistResponseContexts)
    reconcileStoredSessions(this.logs, this.contexts)
    this.router = new ProxyService(() => this.config, this.logs, this.contexts)
    if (this.config.startRouterOnLaunch) void this.router.start()
  }

  get state(): RouterConfig {
    return this.config
  }

  publicState(): object {
    return {
      config: publicConfig(this.config),
      router: this.router.status(),
      logging: this.config.recordLogs,
      sessions: listSessions(this.logs, this.contexts),
      missingContinuations: listMissingContinuations(this.logs, this.contexts),
    }
  }

  async updateConfig(
    patch: Record<string, unknown>,
  ): Promise<{ config: object; router: ReturnType<ProxyService["status"]>; dashboardRestartRequired: boolean }> {
    const { dashboardAuthEnabled, dashboardPassword, dashboardUsername, ...configPatch } = patch
    const previous = this.config
    const dashboardPortChanged =
      configPatch.dashboardPort !== undefined && Number(configPatch.dashboardPort) !== previous.dashboardPort
    const nextAuth = updateDashboardAuth(
      previous.dashboardAuth,
      dashboardAuthEnabled,
      dashboardUsername,
      dashboardPassword,
    )
    this.config = saveConfig({
      ...previous,
      ...configPatch,
      dashboardAuth: nextAuth,
      codexProfile: { ...previous.codexProfile, ...objectFromUnknown(configPatch.codexProfile) },
    })
    this.logs.setRecording(this.config.recordLogs)
    if (!this.config.recordLogs) this.clearTrafficData()
    if (
      configPatch.routerPort !== undefined &&
      Number(configPatch.routerPort) !== previous.routerPort &&
      this.router.status().running
    ) {
      await this.router.stop()
      await this.router.start()
    }
    if (previous.startRouterOnLaunch !== this.config.startRouterOnLaunch) {
      if (this.config.startRouterOnLaunch) await this.router.start()
      else await this.router.stop()
    }
    return {
      config: publicConfig(this.config),
      router: this.router.status(),
      dashboardRestartRequired: dashboardPortChanged,
    }
  }

  async addProvider(value: unknown): Promise<object> {
    const provider = normalizeProvider(value)
    validateProvider(provider, this.config.providers)
    this.config = saveConfig({ ...this.config, providers: [...this.config.providers, provider] })
    return publicProvider(provider)
  }

  async updateProvider(id: string, value: Record<string, unknown>): Promise<object> {
    const index = this.config.providers.findIndex((provider) => provider.id === id)
    const current = this.config.providers[index]
    if (!current) throw new Error("Provider not found.")
    const provider = normalizeProvider({ ...current, ...objectFromUnknown(value), id })
    validateProvider(
      provider,
      this.config.providers.filter((_, itemIndex) => itemIndex !== index),
    )
    const providers = [...this.config.providers]
    providers[index] = provider
    this.config = saveConfig({ ...this.config, providers })
    return publicProvider(provider)
  }

  removeProvider(id: string): void {
    if (!this.config.providers.some((provider) => provider.id === id)) throw new Error("Provider not found.")
    this.config = saveConfig({
      ...this.config,
      providers: this.config.providers.filter((provider) => provider.id !== id),
    })
  }

  clearTrafficData(): void {
    this.logs.clear()
    this.contexts.clear()
  }

  importContext(value: Record<string, unknown>): object {
    const missing = listMissingContinuations(this.logs, this.contexts)
    const responseId = stringValue(value.responseId) || missing[0]?.responseId
    if (!responseId) throw new Error("No missing previous_response_id is available.")
    if (this.contexts.get(responseId)) throw new Error("This response id already has stored context.")
    const matched = missing.find((item) => item.responseId === responseId)
    const provider =
      this.config.providers.find((item) => item.id === stringValue(value.providerId)) || matched?.provider || null
    const label = stringValue(value.label).trim()
    const result = importCopilotTranscript(stringValue(value.filePath), responseId, this.contexts, {
      provider,
      ...(label ? { label } : {}),
    })
    return {
      responseId,
      session: this.contexts.summary(result.context),
      transcriptSessionId: result.transcriptSessionId,
      label: result.label,
      itemCount: result.itemCount,
    }
  }
}

let singleton: RouterRuntime | undefined
export function getRouterRuntime(): RouterRuntime {
  singleton ??= new RouterRuntime()
  return singleton
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : ""
}
