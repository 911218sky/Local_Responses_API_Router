<script setup lang="ts">
import { Plus, X } from "lucide-vue-next"
import { computed } from "vue"
import { useLocale } from "~/composables/useLocale"
import type { Provider } from "~/types"
import { providerRouterRouteFormat, providerRouterUrl } from "~/utils/router-url"

const props = defineProps<{ dashboard: ReturnType<typeof import("~/composables/useDashboard").useDashboard> }>()
const emit = defineEmits<{ openProviders: [] }>()
const { t } = useLocale()
const active = computed(() => props.dashboard.router.value?.activeRequests ?? [])
const recent = computed(() => props.dashboard.logs.value.slice(0, 12))
const requestUrl = useRequestURL()
const route = computed(() => {
  const routerPort = props.dashboard.router.value?.port ?? props.dashboard.config.value?.routerPort
  return props.dashboard.router.value ? providerRouterRouteFormat(requestUrl, routerPort) : t("notStarted")
})
const providers = computed(() => props.dashboard.providers.value.slice(0, 5))

function providerRoute(provider: Provider): string {
  const routerPort = props.dashboard.router.value?.port ?? props.dashboard.config.value?.routerPort
  return providerRouterUrl(requestUrl, routerPort, provider.slug)
}
</script>

<template>
  <section class="page-grid">
    <div class="metrics-grid">
      <article class="metric-card">
        <span>{{ t("overviewRoute") }}</span>
        <strong class="mono">{{ route }}</strong>
        <small>{{ t("routeHint") }}</small>
      </article>
      <article class="metric-card">
        <span>{{ t("forwarding") }}</span>
        <strong>{{ dashboard.config.value?.forwardEnabled ? t("enabled") : t("disabled") }}</strong>
        <small>{{ t("forwardingHint") }}</small>
      </article>
      <article class="metric-card">
        <span>{{ t("transform") }}</span>
        <strong>{{ dashboard.config.value?.transformEnabled ? t("codexFormat") : t("rawFormat") }}</strong>
        <small>{{ t("transformHint") }}</small>
      </article>
      <article class="metric-card">
        <span>{{ t("recentActivity") }}</span>
        <strong>{{ recent.length }}</strong>
        <small>{{ t("savedRequestLogs") }}</small>
      </article>
    </div>
    <section class="surface">
      <div class="section-head">
        <div>
          <h2>{{ t("activeRequests") }}</h2>
          <p>{{ t("activeRequestsHint") }}</p>
        </div>
        <span class="count">{{ active.length }}</span>
      </div>
      <div v-if="!active.length" class="empty">{{ t("noActiveRequests") }}</div>
      <div v-else class="request-list">
        <article v-for="item in active" :key="item.id" class="request-row">
          <div>
            <strong>{{ item.method }} {{ item.path }}</strong>
            <small>{{ item.provider?.name ?? t("unknown") }} · {{ item.sessionId ?? t("noSession") }}</small>
          </div>
          <div class="row-actions">
            <span class="status-badge running">{{ item.status }}</span>
            <button class="small-button danger-button" type="button" @click="dashboard.cancelRequest(item.id)">
              <X :size="14" />
              {{ t("cancel") }}
            </button>
          </div>
        </article>
      </div>
    </section>
    <div class="two-column">
      <section class="surface">
        <div class="section-head">
          <div>
            <h2>{{ t("quickRoutes") }}</h2>
            <p>{{ t("quickRoutesHint") }}</p>
          </div>
          <button class="small-button" type="button" @click="emit('openProviders')">
            <Plus :size="14" />
            {{ t("add") }}
          </button>
        </div>
        <div v-if="!providers.length" class="empty">{{ t("noProviders") }}</div>
        <div v-else class="provider-list">
          <article v-for="provider in providers" :key="provider.id" class="provider-row">
            <div>
              <strong>{{ provider.name }}</strong>
              <small class="mono">{{ providerRoute(provider) }}</small>
            </div>
            <span class="status-badge" :class="provider.enabled ? 'running' : 'stopped'">
              {{ provider.enabled ? t("enabled") : t("disabled") }}
            </span>
          </article>
        </div>
      </section>
      <section class="surface">
        <div class="section-head">
          <div>
            <h2>{{ t("executionControl") }}</h2>
            <p>{{ t("localDataHint") }}</p>
          </div>
        </div>
        <label class="toggle-row">
          <span>
            <b>{{ t("forwardRequests") }}</b>
            <small>{{ t("forwardRequestsHint") }}</small>
          </span>
          <input
            type="checkbox"
            :checked="dashboard.config.value?.forwardEnabled"
            @change="dashboard.saveConfig({ forwardEnabled: ($event.target as HTMLInputElement).checked })"
          >
          <i />
        </label>
        <label class="toggle-row">
          <span>
            <b>{{ t("codexTransform") }}</b>
            <small>{{ t("codexTransformHint") }}</small>
          </span>
          <input
            type="checkbox"
            :checked="dashboard.config.value?.transformEnabled"
            @change="dashboard.saveConfig({ transformEnabled: ($event.target as HTMLInputElement).checked })"
          >
          <i />
        </label>
        <label class="toggle-row">
          <span>
            <b>{{ t("detailedLogs") }}</b>
            <small>{{ t("detailedLogsHint") }}</small>
          </span>
          <input
            type="checkbox"
            :checked="dashboard.config.value?.recordLogs"
            @change="dashboard.saveConfig({ recordLogs: ($event.target as HTMLInputElement).checked })"
          >
          <i />
        </label>
      </section>
    </div>
  </section>
</template>
