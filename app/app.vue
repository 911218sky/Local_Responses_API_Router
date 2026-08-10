<script setup lang="ts">
import { Activity, FlaskConical, Home, Languages, Moon, Power, Server, Settings, Sun } from "lucide-vue-next"
import { callOnce } from "nuxt/app"
import { computed, ref } from "vue"
import DashboardOverview from "~/components/DashboardOverview.vue"
import ProvidersView from "~/components/ProvidersView.vue"
import ProviderTestView from "~/components/ProviderTestView.vue"
import SettingsView from "~/components/SettingsView.vue"
import TrafficView from "~/components/TrafficView.vue"
import { useDashboard } from "~/composables/useDashboard"
import { useLocale } from "~/composables/useLocale"

type Section = "overview" | "providers" | "test" | "traffic" | "settings"

const dashboard = useDashboard()
await callOnce("dashboard-initial-state", dashboard.refresh)
const section = ref<Section>("overview")
type Theme = "light" | "dark"

// Persist the selected theme so SSR and browser hydration share the same palette.
const theme = useCookie<Theme>("codex-router-theme", {
  default: () => "light",
  sameSite: "lax",
})
const dark = computed(() => theme.value === "dark")
const { locale, t } = useLocale()
const sectionMessageKeys: Record<Section, { title: string; subtitle: string }> = {
  overview: { title: "overview", subtitle: "overviewSubtitle" },
  providers: { title: "providers", subtitle: "providersSubtitle" },
  test: { title: "testCenter", subtitle: "testCenterSubtitle" },
  traffic: { title: "traffic", subtitle: "trafficSubtitle" },
  settings: { title: "settings", subtitle: "settingsSubtitle" },
}
const labels = computed(
  () =>
    Object.fromEntries(
      (Object.keys(sectionMessageKeys) as Section[]).map((key) => [
        key,
        {
          title: t(sectionMessageKeys[key].title),
          subtitle: t(sectionMessageKeys[key].subtitle),
        },
      ]),
    ) as Record<Section, { title: string; subtitle: string }>,
)
const current = computed(() => {
  return labels.value[section.value]
})
const running = computed(() => dashboard.router.value?.running === true)

useHead(() => ({
  htmlAttrs: {
    class: dark.value ? "dark" : undefined,
    "data-theme": theme.value,
    lang: locale.value,
  },
}))

function toggleTheme(): void {
  theme.value = dark.value ? "light" : "dark"
}

function stopRouterAndLeave(): void {
  void dashboard.shutdown()
}
</script>

<template>
  <div class="shell" :class="{ dark }">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark">CR</span>
        <div>
          <strong>Codex Router</strong>
          <small>{{ t("localControl") }}</small>
        </div>
      </div>
      <nav class="nav-list" :aria-label="t('dashboardNavigation')">
        <button v-for="item in (Object.keys(labels) as Section[])" :key="item" class="nav-item" :class="{ active: section === item }" type="button" @click="section = item">
          <Home v-if="item === 'overview'" :size="17" aria-hidden="true" />
          <Server v-else-if="item === 'providers'" :size="17" aria-hidden="true" />
          <FlaskConical v-else-if="item === 'test'" :size="17" aria-hidden="true" />
          <Activity v-else-if="item === 'traffic'" :size="17" aria-hidden="true" />
          <Settings v-else :size="17" aria-hidden="true" />
          <span>{{ labels[item].title }}</span>
          <span v-if="item === 'providers'" class="count">{{ dashboard.providers.value.length }}</span>
        </button>
      </nav>
      <div class="sidebar-footer">
        <span class="recording">
          <span class="status-dot" :class="{ on: dashboard.state.value?.logging }" />
          {{ dashboard.state.value?.logging ? t("loggingOn") : t("loggingOff") }}
        </span>
        <div class="footer-actions">
          <label class="language-control">
            <Languages :size="15" aria-hidden="true" />
            <select v-model="locale" :aria-label="t('language')">
              <option value="zh-Hant">繁體中文</option>
              <option value="zh-Hans">简体中文</option>
              <option value="en">English</option>
            </select>
          </label>
          <button
            class="icon-button"
            type="button"
            :title="dark ? t('lightTheme') : t('darkTheme')"
            :aria-label="dark ? t('lightTheme') : t('darkTheme')"
            :aria-pressed="dark"
            @click="toggleTheme"
          >
            <Sun v-if="dark" :size="17" />
            <Moon v-else :size="17" />
          </button>
          <button
            class="icon-button danger-button"
            type="button"
            :title="t('stopRouter')"
            :aria-label="t('stopRouter')"
            :disabled="!running"
            @click="stopRouterAndLeave"
          >
            <Power :size="17" />
          </button>
        </div>
      </div>
    </aside>
    <main class="main-content">
      <header class="topbar">
        <div>
          <h1>{{ current.title }}</h1>
          <p>{{ current.subtitle }}</p>
        </div>
        <div class="top-actions">
          <span class="status-badge" :class="running ? 'running' : 'stopped'">
            {{ running ? t("routerRunning") : t("routerStopped") }}
          </span>
          <button class="primary-button" type="button" :disabled="dashboard.busy.value" @click="dashboard.toggleRouter">
            <Power :size="16" />
            {{ running ? t("stopRouter") : t("startRouter") }}
          </button>
        </div>
      </header>
      <p v-if="dashboard.error.value" class="global-error" role="alert">{{ dashboard.error.value }}</p>
      <DashboardOverview v-show="section === 'overview'" :dashboard="dashboard" @open-providers="section = 'providers'" @open-traffic="section = 'traffic'" />
      <ProvidersView v-show="section === 'providers'" :dashboard="dashboard" />
      <ProviderTestView v-show="section === 'test'" :dashboard="dashboard" />
      <TrafficView v-show="section === 'traffic'" :dashboard="dashboard" />
      <SettingsView v-show="section === 'settings'" :dashboard="dashboard" />
    </main>
  </div>
</template>
