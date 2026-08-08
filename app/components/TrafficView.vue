<script setup lang="ts">
import { RefreshCw, Trash2 } from "lucide-vue-next"
import { computed } from "vue"

const props = defineProps<{ dashboard: ReturnType<typeof import("~/composables/useDashboard").useDashboard> }>()
const selected = computed(() => props.dashboard.selectedSession.value)
const sessionLogs = computed(() =>
  selected.value
    ? props.dashboard.logs.value.filter((log) => log.sessionId === selected.value?.sessionId)
    : props.dashboard.logs.value,
)

function sessionKey(sessionId: string | null): string {
  return sessionId ?? "unknown"
}
</script>

<template>
  <section class="page-grid traffic-page"><div class="session-layout"><aside class="surface session-panel"><div class="panel-title"><strong>工作階段</strong><span class="count">{{ dashboard.sessions.value.length }}</span></div><div v-if="!dashboard.sessions.value.length" class="empty">尚未有已保存的工作階段。</div><button v-for="session in dashboard.sessions.value" :key="sessionKey(session.sessionId)" class="session-button" :class="{ active: selected?.sessionId === session.sessionId }" type="button" @click="dashboard.selectSession(session)"><strong>{{ session.label || session.provider?.name || "未命名工作階段" }}</strong><small>{{ session.count }} 個上下文 · {{ sessionKey(session.sessionId) }}</small></button><div class="panel-actions"><button class="icon-button" type="button" title="重新整理" aria-label="重新整理" @click="dashboard.refresh"><RefreshCw :size="16" /></button><button class="icon-button danger-button" type="button" title="清除紀錄" aria-label="清除紀錄" @click="dashboard.clearLogs"><Trash2 :size="16" /></button></div></aside><section class="surface logs-panel"><div class="panel-title"><div><strong>{{ selected ? "工作階段請求" : "近期請求" }}</strong><small>{{ selected ? selected.sessionId : "所有已保存的請求紀錄" }}</small></div><span class="count">{{ sessionLogs.length }}</span></div><div v-if="!sessionLogs.length" class="empty">沒有可顯示的紀錄。</div><article v-for="log in sessionLogs" :key="log.id" class="log-row"><div><strong>{{ log.path || "未知路徑" }}</strong><small>{{ log.provider?.name || "Unknown" }} · {{ new Date(log.createdAt).toLocaleString() }}</small></div><div class="log-meta"><span class="status-badge" :class="log.status === 'success' ? 'running' : log.status === 'error' ? 'error' : 'stopped'">{{ log.status }}</span><span v-if="log.responseStatus">{{ log.responseStatus }}</span><span v-if="log.durationMs">{{ log.durationMs }} ms</span></div><small v-if="log.error" class="form-error">{{ log.error }}</small></article></section></div></section>
</template>
