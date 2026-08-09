<script setup lang="ts">
import { ArrowRight, ChevronRight, Eye, EyeOff, RefreshCw, Trash2 } from "lucide-vue-next"
import { computed, ref } from "vue"
import { useLocale } from "~/composables/useLocale"
import {
  buildPayloadDiffPairs,
  buildPayloadDiffRows,
  type PayloadDiffPair,
  type PayloadDiffPairKind,
} from "~/utils/dashboard-diff"
import { changeLabels, formatPayload } from "~/utils/session-detail"
import { shouldShowSessionLoading, watchSelectedSessionId } from "~/utils/traffic-view-state"

const props = defineProps<{ dashboard: ReturnType<typeof import("~/composables/useDashboard").useDashboard> }>()
const { t } = useLocale()
const selected = computed(() => props.dashboard.selectedSession.value)
const detail = computed(() => props.dashboard.selectedSessionDetail.value)
const visibleLogs = computed(() => (selected.value ? (detail.value?.logs ?? []) : props.dashboard.logs.value))
const expandedLogIds = ref(new Set<string>())
const showUnchanged = ref(false)
interface DiffSummary {
  readonly labels: readonly string[]
  readonly pairs: readonly PayloadDiffPair[]
  readonly changed: number
  readonly removed: number
  readonly added: number
  readonly unchanged: number
}

const diffSummaryByLogId = computed(() => {
  const summaries = new Map<string, DiffSummary>()
  for (const log of visibleLogs.value) {
    const allPairs =
      expandedLogIds.value.has(log.id) && log.inbound && log.outbound
        ? buildPayloadDiffPairs(buildPayloadDiffRows(log.inbound, log.outbound))
        : []
    const counts: Record<PayloadDiffPairKind, number> = { changed: 0, removed: 0, added: 0, unchanged: 0 }
    for (const pair of allPairs) counts[pair.kind] += 1
    const pairs = showUnchanged.value ? allPairs : allPairs.filter((pair) => pair.kind !== "unchanged")
    summaries.set(log.id, { labels: changeLabels(log), pairs, ...counts })
  }
  return summaries
})

watchSelectedSessionId(selected, () => {
  expandedLogIds.value = new Set<string>()
})

function sessionKey(sessionId: string | null): string {
  return sessionId ?? "unknown"
}

function statusClass(status: string): string {
  return status === "success" || status === "completed"
    ? "running"
    : status === "error" || status === "failed"
      ? "error"
      : "stopped"
}

function diffSummary(logId: string): DiffSummary | undefined {
  return diffSummaryByLogId.value.get(logId)
}

function setLogExpanded(logId: string, event: Event): void {
  const target = event.currentTarget
  if (!(target instanceof HTMLDetailsElement)) return
  const next = new Set(expandedLogIds.value)
  if (target.open) next.add(logId)
  else next.delete(logId)
  expandedLogIds.value = next
}

function isLogExpanded(logId: string): boolean {
  return expandedLogIds.value.has(logId)
}
</script>

<template>
  <section class="page-grid traffic-page">
    <div class="session-layout">
      <aside class="surface session-panel">
        <div class="panel-title">
          <strong>{{ t("traffic") }}</strong>
          <span class="count">{{ dashboard.sessions.value.length }}</span>
        </div>
        <div v-if="!dashboard.sessions.value.length" class="empty">
          {{ dashboard.state.value?.config.persistResponseContexts ? t("noSessions") : t("contextsDisabled") }}
        </div>
        <button
          v-for="session in dashboard.sessions.value"
          :key="sessionKey(session.sessionId)"
          class="session-button"
          :class="{ active: selected?.sessionId === session.sessionId }"
          type="button"
          @click="dashboard.selectSession(session)"
        >
          <strong>{{ session.label || session.provider?.name || t("unnamedSession") }}</strong>
          <small>{{ session.count }} {{ t("savedContextCount") }} · {{ session.requestCount ?? 0 }} {{ t("requestCount") }} · {{ sessionKey(session.sessionId) }}</small>
        </button>
        <div class="panel-actions">
          <button class="icon-button" type="button" :title="t('refresh')" :aria-label="t('refresh')" @click="dashboard.refresh">
            <RefreshCw :size="16" />
          </button>
          <button class="icon-button danger-button" type="button" :title="t('clearLogs')" :aria-label="t('clearLogs')" @click="dashboard.clearLogs">
            <Trash2 :size="16" />
          </button>
        </div>
      </aside>

      <section class="surface logs-panel">
        <div class="panel-title">
          <div>
            <strong>{{ selected ? t("sessionDetails") : t("recentRequests") }}</strong>
            <small>{{ selected ? selected.sessionId : t("allSavedLogs") }}</small>
          </div>
          <span class="count">{{ visibleLogs.length }}</span>
        </div>

        <div v-if="shouldShowSessionLoading(dashboard.detailBusy.value, Boolean(detail))" class="empty">{{ t("loadingSession") }}</div>
        <div v-else-if="selected && detail" class="session-detail">
          <div class="detail-overview">
            <div>
              <span class="detail-kicker">{{ t("sessionSummary") }}</span>
              <strong>{{ selected.label || selected.provider?.name || t("unnamedSession") }}</strong>
            </div>
            <div class="detail-metrics">
              <span><b>{{ detail.contexts.length }}</b> {{ t("savedContexts") }}</span>
              <span><b>{{ detail.logs.length }}</b> {{ t("requestLogs") }}</span>
              <span v-if="detail.replay"><b>{{ detail.replay.history.length }}</b> {{ t("replayItems") }}</span>
            </div>
          </div>
          <div class="detail-stage-list">
            <section v-if="detail.contexts.length" class="detail-stage">
              <div class="detail-stage-heading">
                <span class="stage-number">01</span>
                <div>
                  <strong>{{ t("savedContexts") }}</strong>
                  <small>{{ t("persistContextsHint") }}</small>
                </div>
                <span class="stage-count">{{ detail.contexts.length }}</span>
              </div>
              <details class="secondary-detail">
                <summary>
                  <ChevronRight class="summary-chevron" :size="16" aria-hidden="true" />
                  <span>{{ t("viewContexts") }}</span>
                </summary>
                <div class="context-list">
                  <div v-for="context in detail.contexts" :key="context.responseId" class="context-row">
                    <code>{{ context.responseId }}</code>
                    <span>{{ context.inputItemCount }} {{ t("inputItems") }} · {{ context.outputItemCount }} {{ t("outputItems") }}</span>
                    <small>{{ new Date(context.updatedAt).toLocaleString() }}</small>
                  </div>
                </div>
              </details>
            </section>
            <section v-if="detail.replay" class="detail-stage">
              <div class="detail-stage-heading">
                <span class="stage-number">02</span>
                <div>
                  <strong>{{ t("replayLast") }}</strong>
                  <small>{{ t("replayHint") }}</small>
                </div>
                <span class="stage-count">{{ detail.replay.history.length }}</span>
              </div>
              <details class="secondary-detail">
                <summary>
                  <ChevronRight class="summary-chevron" :size="16" aria-hidden="true" />
                  <span>{{ t("viewReplay") }}</span>
                </summary>
                <div class="replay-block">
                  <pre>{{ formatPayload(detail.replay.history) }}</pre>
                </div>
              </details>
            </section>
          </div>
        </div>

        <div v-if="!visibleLogs.length && !dashboard.detailBusy.value" class="empty">
          {{ dashboard.state.value?.config.recordLogs ? t("noLogs") : t("enableLogsHint") }}
        </div>
        <article v-for="log in visibleLogs" :key="log.id" class="log-row log-detail">
          <div class="log-summary">
            <div>
            <strong>{{ log.method || t("request") }} {{ log.path || t("unknownPath") }}</strong>
              <small>{{ log.provider?.name || t("unknown") }} · {{ new Date(log.createdAt).toLocaleString() }}</small>
            </div>
            <div class="log-meta">
              <span class="status-badge" :class="statusClass(log.status)">{{ log.status }}</span>
              <span v-if="log.responseStatus">{{ log.responseStatus }}</span>
              <span v-if="log.durationMs">{{ log.durationMs }} ms</span>
            </div>
          </div>
          <details
            v-if="selected && (log.inbound || log.outbound || log.response || log.transform)"
            @toggle="setLogExpanded(log.id, $event)"
          >
            <summary>
              <ChevronRight class="summary-chevron" :size="17" aria-hidden="true" />
              <span>{{ t("viewChanges") }}</span>
            </summary>
            <template v-if="isLogExpanded(log.id)">
              <section class="detail-stage log-stage">
                <div class="detail-stage-heading">
                  <span class="stage-number">01</span>
                  <div>
                    <strong>{{ t("requestDiff") }}</strong>
                    <small>{{ t("requestDiffHint") }}</small>
                  </div>
                </div>
                <div class="change-list" v-if="diffSummary(log.id)?.labels.length">
                  <b>{{ t("conversionChanges") }}</b>
                  <span v-for="label in diffSummary(log.id)?.labels ?? []" :key="label" class="change-chip">{{ label }}</span>
                </div>
                <div v-if="log.inbound && log.outbound" class="request-diff">
                  <div class="diff-header">
                    <span class="diff-header-actions">
                      <span v-if="diffSummary(log.id)" class="diff-legend" :aria-label="t('changesSummary')">
                        <span class="diff-legend-item diff-changed">{{ diffSummary(log.id)?.changed }} {{ t("changed") }}</span>
                        <span class="diff-legend-item diff-removed">{{ diffSummary(log.id)?.removed }} {{ t("removed") }}</span>
                        <span class="diff-legend-item diff-added">{{ diffSummary(log.id)?.added }} {{ t("added") }}</span>
                        <span class="diff-legend-item diff-unchanged">{{ diffSummary(log.id)?.unchanged }} {{ t("unchanged") }}</span>
                      </span>
                      <button class="link-button diff-context-toggle" type="button" @click="showUnchanged = !showUnchanged">
                        <EyeOff v-if="showUnchanged" :size="13" aria-hidden="true" />
                        <Eye v-else :size="13" aria-hidden="true" />
                        {{ showUnchanged ? t("hideUnchanged") : t("showUnchanged") }}
                      </button>
                    </span>
                  </div>
                  <div class="split-diff" role="table" :aria-label="t('requestDiff')">
                    <div class="split-diff-heading" role="row">
                      <span role="columnheader">{{ t("inboundRequest") }}</span>
                      <span class="split-diff-flow" aria-hidden="true"><ArrowRight :size="18" /></span>
                      <span role="columnheader">{{ t("outboundRequest") }}</span>
                    </div>
                    <div
                      v-for="pair in diffSummary(log.id)?.pairs ?? []"
                      :key="`${pair.key}-${pair.kind}`"
                      class="split-diff-row"
                      :class="`split-diff-${pair.kind}`"
                      role="row"
                    >
                      <div class="split-diff-cell" :class="{ 'split-diff-empty': !pair.left }" role="cell">
                        <template v-if="pair.left">
                          <code>{{ pair.left.key }}</code>
                          <pre>{{ pair.left.value }}</pre>
                        </template>
                      </div>
                      <span class="split-diff-flow" aria-hidden="true"><ArrowRight :size="16" /></span>
                      <div class="split-diff-cell" :class="{ 'split-diff-empty': !pair.right }" role="cell">
                        <template v-if="pair.right">
                          <code>{{ pair.right.key }}</code>
                          <pre>{{ pair.right.value }}</pre>
                        </template>
                      </div>
                    </div>
                  </div>
                </div>
                <div v-else class="payload-grid">
                  <div v-if="log.inbound"><b>{{ t("inboundRequest") }}</b><pre>{{ formatPayload(log.inbound) }}</pre></div>
                  <div v-if="log.outbound"><b>{{ t("outboundRequest") }}</b><pre>{{ formatPayload(log.outbound) }}</pre></div>
                </div>
              </section>
              <section v-if="log.response" class="detail-stage log-stage upstream-stage">
                <div class="detail-stage-heading">
                  <span class="stage-number">02</span>
                  <div>
                    <strong>{{ t("upstreamResponse") }}</strong>
                    <small>{{ t("upstreamResponseHint") }}</small>
                  </div>
                  <span class="stage-count">{{ t("fullPayload") }}</span>
                </div>
                <div class="upstream-response">
                  <pre>{{ formatPayload(log.response) }}</pre>
                </div>
              </section>
            </template>
          </details>
          <small v-if="log.error" class="form-error">{{ log.error }}</small>
        </article>
      </section>
    </div>
  </section>
</template>
