<script setup lang="ts">
import { reactive, watch } from "vue"

const props = defineProps<{ dashboard: ReturnType<typeof import("~/composables/useDashboard").useDashboard> }>()
interface SettingsDraft {
  retryCount: number
  capacityRetryCount: number
  retryDelayMs: number
  activeRequestTimeoutMs: number
  persistResponseContexts: boolean
  startRouterOnLaunch: boolean
  dashboardAuthEnabled: boolean
  dashboardUsername: string
  dashboardPassword: string
  sendUserAgent: boolean
  userAgent: string
  sendOriginator: boolean
  originator: string
  sendBetaFeatures: boolean
  betaFeatures: string
  sendResponsesLite: boolean
  responsesLite: boolean
}
const draft = reactive<SettingsDraft>({
  retryCount: 2,
  capacityRetryCount: 5,
  retryDelayMs: 800,
  activeRequestTimeoutMs: 300000,
  persistResponseContexts: true,
  startRouterOnLaunch: false,
  dashboardAuthEnabled: false,
  dashboardUsername: "",
  dashboardPassword: "",
  sendUserAgent: true,
  userAgent: "",
  sendOriginator: true,
  originator: "",
  sendBetaFeatures: true,
  betaFeatures: "",
  sendResponsesLite: true,
  responsesLite: true,
})
watch(
  () => props.dashboard.config.value,
  (config) => {
    if (!config) return
    Object.assign(draft, {
      retryCount: config.retryCount,
      capacityRetryCount: config.capacityRetryCount,
      retryDelayMs: config.retryDelayMs,
      activeRequestTimeoutMs: config.activeRequestTimeoutMs,
      persistResponseContexts: config.persistResponseContexts,
      startRouterOnLaunch: config.startRouterOnLaunch,
      dashboardAuthEnabled: config.dashboardAuth.enabled,
      dashboardUsername: config.dashboardAuth.username,
      sendUserAgent: config.codexProfile.sendUserAgent,
      userAgent: config.codexProfile.userAgent,
      sendOriginator: config.codexProfile.sendOriginator,
      originator: config.codexProfile.originator,
      sendBetaFeatures: config.codexProfile.sendBetaFeatures,
      betaFeatures: config.codexProfile.betaFeatures,
      sendResponsesLite: config.codexProfile.sendResponsesLite,
      responsesLite: config.codexProfile.responsesLite,
    })
  },
  { immediate: true },
)
async function save(): Promise<void> {
  await props.dashboard.saveConfig({
    retryCount: draft.retryCount,
    capacityRetryCount: draft.capacityRetryCount,
    retryDelayMs: draft.retryDelayMs,
    activeRequestTimeoutMs: draft.activeRequestTimeoutMs,
    persistResponseContexts: draft.persistResponseContexts,
    startRouterOnLaunch: draft.startRouterOnLaunch,
    dashboardAuthEnabled: draft.dashboardAuthEnabled,
    dashboardUsername: draft.dashboardUsername,
    dashboardPassword: draft.dashboardPassword,
    codexProfile: {
      userAgent: draft.userAgent,
      originator: draft.originator,
      betaFeatures: draft.betaFeatures,
      responsesLite: draft.responsesLite,
      sendUserAgent: draft.sendUserAgent,
      sendOriginator: draft.sendOriginator,
      sendBetaFeatures: draft.sendBetaFeatures,
      sendResponsesLite: draft.sendResponsesLite,
    },
  })
}
</script>

<template>
  <section class="page-grid"><div class="section-head page-heading"><p>設定會保存於本機資料目錄，密碼只會在啟用時更新。</p><button class="primary-button" type="button" :disabled="dashboard.busy.value" @click="save">保存設定</button></div><form class="settings-grid" @submit.prevent="save"><section class="surface"><h2>服務行為</h2><label>失敗重試次數<input v-model.number="draft.retryCount" type="number" min="0" max="100"></label><label>容量錯誤重試次數<input v-model.number="draft.capacityRetryCount" type="number" min="0" max="100"></label><label>重試間隔（毫秒）<input v-model.number="draft.retryDelayMs" type="number" min="100" max="30000"></label><label>請求逾時（毫秒）<input v-model.number="draft.activeRequestTimeoutMs" type="number" min="1000" max="3600000"></label><label class="toggle-row"><span><b>保存延續上下文</b><small>服務重啟後仍可重播 response history。</small></span><input v-model="draft.persistResponseContexts" type="checkbox"><i /></label><label class="toggle-row"><span><b>啟動時啟動 Router</b><small>Nuxt 啟動後自動監聽 Router 埠。</small></span><input v-model="draft.startRouterOnLaunch" type="checkbox"><i /></label></section><section class="surface"><h2>Dashboard 認證</h2><label class="toggle-row"><span><b>啟用認證</b><small>要求帳號密碼才能使用 Dashboard。</small></span><input v-model="draft.dashboardAuthEnabled" type="checkbox"><i /></label><label>帳號<input v-model.trim="draft.dashboardUsername" autocomplete="username"></label><label>密碼<input v-model="draft.dashboardPassword" type="password" autocomplete="new-password" placeholder="留白以保留現有密碼"></label></section><section class="surface settings-wide"><h2>Codex 請求識別</h2><label class="toggle-row"><span><b>傳送 User-Agent</b><small>使用下方設定的 User-Agent。</small></span><input v-model="draft.sendUserAgent" type="checkbox"><i /></label><label>User-Agent<input v-model="draft.userAgent"></label><label class="toggle-row"><span><b>傳送 Originator</b><small>包含 Originator 標頭。</small></span><input v-model="draft.sendOriginator" type="checkbox"><i /></label><label>Originator<input v-model="draft.originator"></label><label class="toggle-row"><span><b>傳送 Beta features</b><small>包含 x-codex-beta-features。</small></span><input v-model="draft.sendBetaFeatures" type="checkbox"><i /></label><label>Beta features<input v-model="draft.betaFeatures"></label><label class="toggle-row"><span><b>傳送 Responses Lite</b><small>包含內部 Responses Lite 標頭。</small></span><input v-model="draft.sendResponsesLite" type="checkbox"><i /></label><label class="toggle-row"><span><b>Responses Lite 值</b><small>標頭開啟時傳送 true 或 false。</small></span><input v-model="draft.responsesLite" type="checkbox"><i /></label></section></form></section>
</template>
