import { useState } from "nuxt/app"
import { computed, onMounted, onUnmounted, readonly, ref } from "vue"
import type { DashboardState, Provider, RequestLog, RouterConfig, RouterStatus, Session, SessionDetail } from "~/types"

type DashboardRequestOptions = {
  readonly method?: "GET" | "POST" | "PUT" | "DELETE"
  readonly body?: unknown
}

export function useDashboard() {
  const state = useState<DashboardState | null>("dashboard-state", () => null)
  const logs = useState<RequestLog[]>("dashboard-logs", () => [])
  const selectedSession = useState<Session | null>("dashboard-selected-session", () => null)
  const selectedSessionDetail = useState<SessionDetail | null>("dashboard-selected-session-detail", () => null)
  const busy = ref(false)
  const detailBusy = ref(false)
  const error = ref("")
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let refreshInFlight: Promise<void> | null = null
  let detailRequestId = 0

  async function request<T>(path: string, options: DashboardRequestOptions = {}): Promise<T> {
    const requestOptions = {
      headers: { "content-type": "application/json" },
      ...(options.method ? { method: options.method } : {}),
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }
    return $fetch<T>(path, requestOptions)
  }

  async function performRefresh(): Promise<void> {
    try {
      const selectedKey = selectedSession.value ? sessionKey(selectedSession.value.sessionId) : null
      const [nextState, nextLogs] = await Promise.all([
        request<DashboardState>("/api/state"),
        request<{ readonly enabled: boolean; readonly logs: RequestLog[] }>("/api/logs"),
      ])
      state.value = nextState
      logs.value = nextLogs.logs
      selectedSession.value = selectedKey
        ? (nextState.sessions.find((item) => sessionKey(item.sessionId) === selectedKey) ?? null)
        : null
      if (selectedSession.value) await loadSessionDetail(sessionKey(selectedSession.value.sessionId))
      else {
        detailRequestId += 1
        selectedSessionDetail.value = null
      }
      error.value = ""
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  async function refresh(): Promise<void> {
    if (refreshInFlight) return refreshInFlight
    refreshInFlight = performRefresh()
    try {
      await refreshInFlight
    } finally {
      refreshInFlight = null
    }
  }

  async function loadSessionDetail(sessionId: string): Promise<void> {
    const requestId = ++detailRequestId
    detailBusy.value = true
    try {
      const nextDetail = await request<SessionDetail>(`/api/sessions/${encodeURIComponent(sessionId)}`)
      if (
        requestId === detailRequestId &&
        selectedSession.value &&
        sessionKey(selectedSession.value.sessionId) === sessionId
      )
        selectedSessionDetail.value = nextDetail
    } catch (cause) {
      if (requestId === detailRequestId) {
        selectedSessionDetail.value = null
        error.value = cause instanceof Error ? cause.message : String(cause)
      }
    } finally {
      if (requestId === detailRequestId) detailBusy.value = false
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
  const selectSession = async (session: Session | null): Promise<void> => {
    detailRequestId += 1
    selectedSession.value = session
    selectedSessionDetail.value = null
    if (session) await loadSessionDetail(sessionKey(session.sessionId))
  }
  return {
    state: readonly(state),
    logs: readonly(logs),
    router,
    config,
    providers,
    sessions,
    selectedSession: readonly(selectedSession),
    selectedSessionDetail: readonly(selectedSessionDetail),
    busy: readonly(busy),
    detailBusy: readonly(detailBusy),
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

function sessionKey(sessionId: string | null): string {
  return sessionId ?? "unknown"
}
