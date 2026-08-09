<script setup lang="ts">
import { reactive, watch } from "vue"
import { useLocale } from "~/composables/useLocale"

const props = defineProps<{ dashboard: ReturnType<typeof import("~/composables/useDashboard").useDashboard> }>()
const { t } = useLocale()
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
  <section class="page-grid"><div class="section-head page-heading"><p>{{ t("settingsHint") }}</p><button class="primary-button" type="button" :disabled="dashboard.busy.value" @click="save">{{ t("saveSettings") }}</button></div><form class="settings-grid" @submit.prevent="save"><section class="surface"><h2>{{ t("serviceBehavior") }}</h2><label>{{ t("retryCount") }}<input v-model.number="draft.retryCount" type="number" min="0" max="100"></label><label>{{ t("capacityRetryCount") }}<input v-model.number="draft.capacityRetryCount" type="number" min="0" max="100"></label><label>{{ t("retryDelay") }}<input v-model.number="draft.retryDelayMs" type="number" min="100" max="30000"></label><label>{{ t("requestTimeout") }}<input v-model.number="draft.activeRequestTimeoutMs" type="number" min="1000" max="3600000"></label><label class="toggle-row"><span><b>{{ t("persistContexts") }}</b><small>{{ t("persistContextsHint") }}</small></span><input v-model="draft.persistResponseContexts" type="checkbox"><i /></label><label class="toggle-row"><span><b>{{ t("startOnLaunch") }}</b><small>{{ t("startOnLaunchHint") }}</small></span><input v-model="draft.startRouterOnLaunch" type="checkbox"><i /></label></section><section class="surface"><h2>{{ t("dashboardAuth") }}</h2><label class="toggle-row"><span><b>{{ t("authEnabled") }}</b><small>{{ t("authHint") }}</small></span><input v-model="draft.dashboardAuthEnabled" type="checkbox"><i /></label><label>{{ t("username") }}<input v-model.trim="draft.dashboardUsername" autocomplete="username"></label><label>{{ t("password") }}<input v-model="draft.dashboardPassword" type="password" autocomplete="new-password" :placeholder="t('keepPassword')"></label></section><section class="surface settings-wide"><h2>{{ t("codexIdentity") }}</h2><label class="toggle-row"><span><b>{{ t("sendUserAgent") }}</b><small>{{ t("userAgentHint") }}</small></span><input v-model="draft.sendUserAgent" type="checkbox"><i /></label><label>{{ t("userAgent") }}<input v-model="draft.userAgent"></label><label class="toggle-row"><span><b>{{ t("sendOriginator") }}</b><small>{{ t("originatorHint") }}</small></span><input v-model="draft.sendOriginator" type="checkbox"><i /></label><label>{{ t("originator") }}<input v-model="draft.originator"></label><label class="toggle-row"><span><b>{{ t("sendBeta") }}</b><small>{{ t("betaHint") }}</small></span><input v-model="draft.sendBetaFeatures" type="checkbox"><i /></label><label>{{ t("betaFeatures") }}<input v-model="draft.betaFeatures"></label><label class="toggle-row"><span><b>{{ t("sendResponsesLite") }}</b><small>{{ t("responsesLiteHint") }}</small></span><input v-model="draft.sendResponsesLite" type="checkbox"><i /></label><label class="toggle-row"><span><b>{{ t("responsesLiteValue") }}</b><small>{{ t("responsesLiteHint") }}</small></span><input v-model="draft.responsesLite" type="checkbox"><i /></label></section></form></section>
</template>
