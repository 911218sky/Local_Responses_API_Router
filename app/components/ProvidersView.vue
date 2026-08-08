<script setup lang="ts">
import { Pencil, Plus, Trash2, X } from "lucide-vue-next"
import { ref } from "vue"
import type { Provider } from "~/types"

const props = defineProps<{ dashboard: ReturnType<typeof import("~/composables/useDashboard").useDashboard> }>()
const dialogOpen = ref(false)
const editing = ref<Provider | null>(null)
const form = ref({ name: "", slug: "", baseUrl: "", enabled: true, routeOnly: false })
const formError = ref("")

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
  if (!window.confirm(`確定刪除「${provider.name}」？`)) return
  await props.dashboard.removeProvider(provider.id)
}
</script>

<template>
  <section class="page-grid"><div class="section-head page-heading"><div><p>將路由識別填入 Codex 的本機 Router URL 第一段。</p></div><button class="primary-button" type="button" @click="open()"><Plus :size="16" />新增提供商</button></div><section class="surface table-surface"><div v-if="!dashboard.providers.value.length" class="empty">尚未設定提供商。</div><template v-else><div class="table-head"><span>名稱</span><span>路由識別</span><span>上游 URL</span><span>狀態</span><span>模式</span><span>操作</span></div><div v-for="provider in dashboard.providers.value" :key="provider.id" class="table-row"><strong>{{ provider.name }}</strong><code>{{ provider.slug }}</code><span class="truncate mono">{{ provider.baseUrl }}</span><span class="status-badge" :class="provider.enabled ? 'running' : 'stopped'">{{ provider.enabled ? "啟用" : "停用" }}</span><span>{{ provider.routeOnly ? "僅路由" : "轉換" }}</span><div class="row-actions"><button class="icon-button" type="button" title="編輯" aria-label="編輯" @click="open(provider)"><Pencil :size="15" /></button><button class="icon-button danger-button" type="button" title="刪除" aria-label="刪除" @click="remove(provider)"><Trash2 :size="15" /></button></div></div></template></section><dialog :open="dialogOpen" class="dialog" @close="dialogOpen = false"><form method="dialog" @submit.prevent="save"><div class="dialog-head"><h2>{{ editing ? "編輯提供商" : "新增提供商" }}</h2><button class="icon-button" type="button" aria-label="關閉" @click="dialogOpen = false"><X :size="16" /></button></div><label>名稱<input v-model.trim="form.name" required autocomplete="off"></label><label>路由識別<input v-model.trim="form.slug" required pattern="[A-Za-z0-9_-]+" autocomplete="off"></label><label>上游 Base URL<input v-model.trim="form.baseUrl" required type="url" placeholder="https://example.com/v1"></label><label class="toggle-row"><span><b>啟用</b><small>接受此提供商的請求。</small></span><input v-model="form.enabled" type="checkbox"><i /></label><label class="toggle-row"><span><b>僅路由</b><small>保留原始請求，不進行 Codex 轉換。</small></span><input v-model="form.routeOnly" type="checkbox"><i /></label><p v-if="formError" class="form-error" role="alert">{{ formError }}</p><div class="dialog-actions"><button type="button" @click="dialogOpen = false">取消</button><button class="primary-button" type="submit">保存提供商</button></div></form></dialog></section>
</template>
