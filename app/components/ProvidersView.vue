<script setup lang="ts">
import { Pencil, Plus, Trash2, X } from "lucide-vue-next"
import { ref } from "vue"
import { useLocale } from "~/composables/useLocale"
import type { Provider } from "~/types"

const props = defineProps<{ dashboard: ReturnType<typeof import("~/composables/useDashboard").useDashboard> }>()
const dialogOpen = ref(false)
const editing = ref<Provider | null>(null)
const form = ref({ name: "", slug: "", baseUrl: "", enabled: true, routeOnly: false })
const formError = ref("")
const { t } = useLocale()

function open(provider?: Provider): void {
  editing.value = provider ?? null
  form.value = provider
    ? {
        name: provider.name,
        slug: provider.slug,
        baseUrl: provider.baseUrl,
        enabled: provider.enabled,
        routeOnly: provider.routeOnly,
      }
    : { name: "", slug: "", baseUrl: "", enabled: true, routeOnly: false }
  formError.value = ""
  dialogOpen.value = true
}

async function save(): Promise<void> {
  formError.value = ""
  try {
    if (editing.value) await props.dashboard.updateProvider(editing.value.id, form.value)
    else await props.dashboard.addProvider(form.value)
    dialogOpen.value = false
  } catch (cause) {
    formError.value = cause instanceof Error ? cause.message : String(cause)
  }
}

async function remove(provider: Provider): Promise<void> {
  if (!window.confirm(`${t("confirmDelete")} "${provider.name}"?`)) return
  await props.dashboard.removeProvider(provider.id)
}
</script>

<template>
  <section class="page-grid"><div class="section-head page-heading"><div><p>{{ t("providersHint") }}</p></div><button class="primary-button" type="button" @click="open()"><Plus :size="16" />{{ t("addProvider") }}</button></div><section class="surface table-surface"><div v-if="!dashboard.providers.value.length" class="empty">{{ t("noProviders") }}</div><template v-else><div class="table-head"><span>{{ t("providerName") }}</span><span>{{ t("routeIdentifier") }}</span><span>{{ t("upstreamUrl") }}</span><span>{{ t("status") }}</span><span>{{ t("mode") }}</span><span>{{ t("actions") }}</span></div><div v-for="provider in dashboard.providers.value" :key="provider.id" class="table-row"><strong>{{ provider.name }}</strong><code>{{ provider.slug }}</code><span class="truncate mono">{{ provider.baseUrl }}</span><span class="status-badge" :class="provider.enabled ? 'running' : 'stopped'">{{ provider.enabled ? t("enabled") : t("disabled") }}</span><span>{{ provider.routeOnly ? t("routeOnly") : t("conversion") }}</span><div class="row-actions"><button class="icon-button" type="button" :title="t('edit')" :aria-label="t('edit')" @click="open(provider)"><Pencil :size="15" /></button><button class="icon-button danger-button" type="button" :title="t('delete')" :aria-label="t('delete')" @click="remove(provider)"><Trash2 :size="15" /></button></div></div></template></section><dialog :open="dialogOpen" class="dialog" @close="dialogOpen = false"><form method="dialog" @submit.prevent="save"><div class="dialog-head"><h2>{{ editing ? t("editProvider") : t("addProvider") }}</h2><button class="icon-button" type="button" :aria-label="t('close')" @click="dialogOpen = false"><X :size="16" /></button></div><label>{{ t("providerName") }}<input v-model.trim="form.name" required autocomplete="off"></label><label>{{ t("routeIdentifier") }}<input v-model.trim="form.slug" required pattern="[A-Za-z0-9_-]+" autocomplete="off"></label><label>{{ t("baseUrl") }}<input v-model.trim="form.baseUrl" required type="url" placeholder="https://example.com/v1"></label><label class="toggle-row"><span><b>{{ t("enabled") }}</b><small>{{ t("acceptProvider") }}</small></span><input v-model="form.enabled" type="checkbox"><i /></label><label class="toggle-row"><span><b>{{ t("routeOnly") }}</b><small>{{ t("routeOnlyHint") }}</small></span><input v-model="form.routeOnly" type="checkbox"><i /></label><p v-if="formError" class="form-error" role="alert">{{ formError }}</p><div class="dialog-actions"><button type="button" @click="dialogOpen = false">{{ t("cancelDialog") }}</button><button class="primary-button" type="submit">{{ t("saveProvider") }}</button></div></form></dialog></section>
</template>
