<script setup lang="ts">
import { Activity, Home, Languages, Moon, Power, Server, Settings, Sun } from "lucide-vue-next"
import { callOnce } from "nuxt/app"
import { computed, ref } from "vue"
import DashboardOverview from "~/components/DashboardOverview.vue"
import ProvidersView from "~/components/ProvidersView.vue"
import SettingsView from "~/components/SettingsView.vue"
import TrafficView from "~/components/TrafficView.vue"
import { useDashboard } from "~/composables/useDashboard"

type Section = "overview" | "providers" | "traffic" | "settings"

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
const locale = ref("zh-Hant")
const labels: Record<Section, { title: string; subtitle: string }> = {
  overview: { title: "總覽", subtitle: "本機 Codex 相容路由服務" },
  providers: { title: "提供商", subtitle: "管理上游服務與本機路由識別" },
  traffic: { title: "工作階段", subtitle: "檢視請求紀錄與已保存的上下文" },
  settings: { title: "設定", subtitle: "調整 Router 行為與請求識別" },
}
const current = computed(() => labels[section.value])
const running = computed(() => dashboard.router.value?.running === true)

useHead(() => ({
  htmlAttrs: {
    class: dark.value ? "dark" : undefined,
    "data-theme": theme.value,
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
        <div><strong>Codex Router</strong><small>LOCAL CONTROL</small></div>
      </div>
      <nav class="nav-list" aria-label="Dashboard navigation">
        <button v-for="item in (Object.keys(labels) as Section[])" :key="item" class="nav-item" :class="{ active: section === item }" type="button" @click="section = item">
          <Home v-if="item === 'overview'" :size="17" aria-hidden="true" />
          <Server v-else-if="item === 'providers'" :size="17" aria-hidden="true" />
          <Activity v-else-if="item === 'traffic'" :size="17" aria-hidden="true" />
          <Settings v-else :size="17" aria-hidden="true" />
          <span>{{ labels[item].title }}</span>
          <span v-if="item === 'providers'" class="count">{{ dashboard.providers.value.length }}</span>
        </button>
      </nav>
      <div class="sidebar-footer">
        <span class="recording"><span class="status-dot" :class="{ on: dashboard.state.value?.logging }" />{{ dashboard.state.value?.logging ? "紀錄開啟" : "紀錄關閉" }}</span>
        <div class="footer-actions">
          <label class="language-control"><Languages :size="15" aria-hidden="true" /><select v-model="locale" aria-label="語言"><option value="zh-Hant">繁體中文</option><option value="zh-Hans">简体中文</option><option value="en">English</option></select></label>
          <button class="icon-button" type="button" :title="dark ? '切換淺色模式' : '切換深色模式'" :aria-label="dark ? '切換淺色模式' : '切換深色模式'" :aria-pressed="dark" @click="toggleTheme"><Sun v-if="dark" :size="17" /><Moon v-else :size="17" /></button>
          <button class="icon-button danger-button" type="button" title="停止 Router" aria-label="停止 Router" :disabled="!running" @click="stopRouterAndLeave"><Power :size="17" /></button>
        </div>
      </div>
    </aside>
    <main class="main-content">
      <header class="topbar">
        <div><h1>{{ current.title }}</h1><p>{{ current.subtitle }}</p></div>
        <div class="top-actions">
          <span class="status-badge" :class="running ? 'running' : 'stopped'">{{ running ? "Router 執行中" : "Router 已停止" }}</span>
          <button class="primary-button" type="button" :disabled="dashboard.busy.value" @click="dashboard.toggleRouter"><Power :size="16" />{{ running ? "停止 Router" : "啟動 Router" }}</button>
        </div>
      </header>
      <p v-if="dashboard.error.value" class="global-error" role="alert">{{ dashboard.error.value }}</p>
      <DashboardOverview v-if="section === 'overview'" :dashboard="dashboard" @open-providers="section = 'providers'" @open-traffic="section = 'traffic'" />
      <ProvidersView v-else-if="section === 'providers'" :dashboard="dashboard" />
      <TrafficView v-else-if="section === 'traffic'" :dashboard="dashboard" />
      <SettingsView v-else :dashboard="dashboard" />
    </main>
  </div>
</template>
