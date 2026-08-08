<script setup lang="ts">
import { Plus, X } from "lucide-vue-next"
import { computed } from "vue"
import type { Provider } from "~/types"

const props = defineProps<{ dashboard: ReturnType<typeof import("~/composables/useDashboard").useDashboard> }>()
const emit = defineEmits<{ openProviders: []; openTraffic: [] }>()
const active = computed(() => props.dashboard.router.value?.activeRequests ?? [])
const recent = computed(() => props.dashboard.logs.value.slice(0, 12))
const route = computed(() => props.dashboard.router.value?.routeFormat ?? "尚未啟動")
const providers = computed(() => props.dashboard.providers.value.slice(0, 5))

function providerRoute(provider: Provider): string {
  return `${route.value.replace("{provider}", provider.slug)}`
}
</script>

<template>
  <section class="page-grid">
    <div class="metrics-grid">
      <article class="metric-card"><span>Router 端點</span><strong class="mono">{{ route }}</strong><small>依路徑第一段識別提供商</small></article>
      <article class="metric-card"><span>轉送</span><strong>{{ dashboard.config.value?.forwardEnabled ? "已啟用" : "已停用" }}</strong><small>只有開啟時才會送出請求</small></article>
      <article class="metric-card"><span>轉換</span><strong>{{ dashboard.config.value?.transformEnabled ? "Codex 格式" : "原始格式" }}</strong><small>保持歷史重播與請求轉換設定</small></article>
      <article class="metric-card"><span>近期活動</span><strong>{{ recent.length }}</strong><small>已儲存的請求紀錄</small></article>
    </div>
    <section class="surface">
      <div class="section-head"><div><h2>進行中的請求</h2><p>每個處理中的請求會獨立追蹤，包括僅路由流量。</p></div><span class="count">{{ active.length }}</span></div>
      <div v-if="!active.length" class="empty">目前沒有進行中的請求。</div>
      <div v-else class="request-list">
        <article v-for="item in active" :key="item.id" class="request-row"><div><strong>{{ item.method }} {{ item.path }}</strong><small>{{ item.provider?.name ?? "Unknown" }} · {{ item.sessionId ?? "無工作階段" }}</small></div><div class="row-actions"><span class="status-badge running">{{ item.status }}</span><button class="small-button danger-button" type="button" @click="dashboard.cancelRequest(item.id)"><X :size="14" />取消</button></div></article>
      </div>
    </section>
    <div class="two-column">
      <section class="surface"><div class="section-head"><div><h2>快速路由</h2><p>每個提供商都有獨立的本機路由。</p></div><button class="small-button" type="button" @click="emit('openProviders')"><Plus :size="14" />新增</button></div><div v-if="!providers.length" class="empty">尚未設定提供商。</div><div v-else class="provider-list"><article v-for="provider in providers" :key="provider.id" class="provider-row"><div><strong>{{ provider.name }}</strong><small class="mono">{{ providerRoute(provider) }}</small></div><span class="status-badge" :class="provider.enabled ? 'running' : 'stopped'">{{ provider.enabled ? "啟用" : "停用" }}</span></article></div></section>
      <section class="surface"><div class="section-head"><div><h2>執行控制</h2><p>變更會保存到本機資料目錄。</p></div></div><label class="toggle-row"><span><b>轉送請求</b><small>關閉時拒絕連線，不接觸上游。</small></span><input type="checkbox" :checked="dashboard.config.value?.forwardEnabled" @change="dashboard.saveConfig({ forwardEnabled: ($event.target as HTMLInputElement).checked })"><i /></label><label class="toggle-row"><span><b>Codex 轉換</b><small>套用標準路徑、標頭與歷史重播。</small></span><input type="checkbox" :checked="dashboard.config.value?.transformEnabled" @change="dashboard.saveConfig({ transformEnabled: ($event.target as HTMLInputElement).checked })"><i /></label><label class="toggle-row"><span><b>詳細紀錄</b><small>將請求與回應摘要保存於本機。</small></span><input type="checkbox" :checked="dashboard.config.value?.recordLogs" @change="dashboard.saveConfig({ recordLogs: ($event.target as HTMLInputElement).checked })"><i /></label></section>
    </div>
    <section class="surface protocol"><div class="section-head"><div><h2>轉換路徑</h2><p>啟用紀錄後，Proxy 會為每個請求保留轉換摘要。</p></div><button class="link-button" type="button" @click="emit('openTraffic')">開啟紀錄</button></div><div class="protocol-line"><span>Codex 請求</span><code>POST /&lt;provider&gt;/v1/responses</code><b>→</b><span>Router</span><code>POST /v1/responses</code><b>→</b><span>上游服務</span></div></section>
  </section>
</template>
