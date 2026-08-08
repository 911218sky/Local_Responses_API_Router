import { useState } from "nuxt/app"
import { computed, onMounted, onUnmounted, readonly, ref } from "vue"
import type { DashboardState, Provider, RequestLog, RouterConfig, RouterStatus, Session } from "~/types"

type DashboardRequestOptions = {
  readonly method?: "GET" | "POST" | "PUT" | "DELETE"
  readonly body?: unknown
}

export function useDashboard() {
  const state = useState<DashboardState | null>("dashboard-state", () => null)
  const logs = useState<RequestLog[]>("dashboard-logs", () => [])
  const selectedSession = useState<Session | null>("dashboard-selected-session", () => null)
  const busy = ref(false)
  const error = ref("")
  let pollTimer: ReturnType<typeof setInterval> | undefined

  async function request<T>(path: string, options: DashboardRequestOptions = {}): Promise<T> {
    const requestOptions = {
      headers: { "content-type": "application/json" },
      ...(options.method ? { method: options.method } : {}),
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }
    return $fetch<T>(path, requestOptions)
  }

  async function refresh(): Promise<void> {
    try {
      const [nextState, nextLogs] = await Promise.all([
        request<DashboardState>("/api/state"),
        request<{ readonly enabled: boolean; readonly logs: RequestLog[] }>("/api/logs"),
      ])
      state.value = nextState
      logs.value = nextLogs.logs
      if (selectedSession.value)
        selectedSession.value =
          nextState.sessions.find((item) => item.sessionId === selectedSession.value?.sessionId) ?? null
      error.value = ""
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  async function mutate(
    path: string,
    method: DashboardRequestOptions["method"] = "POST",
    body?: unknown,
  ): Promise<void> {
    busy.value = true
    try {
      await request(path, { method, body })
      await refresh()
    } finally {
      busy.value = false
    }
  }

  function startPolling(): void {
    if (pollTimer) return
    void refresh()
    pollTimer = setInterval(() => void refresh(), 2000)
  }

  function stopPolling(): void {
    if (!pollTimer) return
    clearInterval(pollTimer)
    pollTimer = undefined
  }

  onMounted(startPolling)
  onUnmounted(stopPolling)
  const router = computed<RouterStatus | null>(() => state.value?.router ?? null)
  const config = computed<RouterConfig | null>(() => state.value?.config ?? null)
  const providers = computed<Provider[]>(() => state.value?.config.providers ?? [])
  const sessions = computed<Session[]>(() => state.value?.sessions ?? [])
  const toggleRouter = () => mutate(router.value?.running ? "/api/router/stop" : "/api/router/start")
  const saveConfig = (patch: Record<string, unknown>) => mutate("/api/config", "PUT", patch)
  const addProvider = (provider: Omit<Provider, "id">) => mutate("/api/providers", "POST", provider)
  const updateProvider = (id: string, provider: Partial<Provider>) =>
    mutate(`/api/providers/${encodeURIComponent(id)}`, "PUT", provider)
  const removeProvider = (id: string) => mutate(`/api/providers/${encodeURIComponent(id)}`, "DELETE")
  const clearLogs = () => mutate("/api/logs", "DELETE")
  const cancelRequest = (id: string) => mutate(`/api/active-requests/${encodeURIComponent(id)}/cancel`)
  const shutdown = () => mutate("/api/shutdown")
  const selectSession = (session: Session | null) => {
    selectedSession.value = session
  }
  return {
    state: readonly(state),
    logs: readonly(logs),
    router,
    config,
    providers,
    sessions,
    selectedSession: readonly(selectedSession),
    busy: readonly(busy),
    error: readonly(error),
    refresh,
    toggleRouter,
    saveConfig,
    addProvider,
    updateProvider,
    removeProvider,
    clearLogs,
    cancelRequest,
    shutdown,
    selectSession,
  }
}
