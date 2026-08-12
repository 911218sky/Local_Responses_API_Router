<script setup lang="ts">
import { Check, ChevronDown, ChevronUp, Copy, CopyPlus, GripVertical, Pencil, Plus, Power, Trash2, X } from "lucide-vue-next"
import { computed, ref } from "vue"
import { useLocale } from "~/composables/useLocale"
import type { Provider } from "~/types"
import { providerRouterUrl } from "~/utils/router-url"

const props = defineProps<{ dashboard: ReturnType<typeof import("~/composables/useDashboard").useDashboard> }>()
const dialogOpen = ref(false)
const editing = ref<Provider | null>(null)
const form = ref({
  name: "",
  slug: "",
  baseUrl: "",
  enabled: true,
  routeOnly: false,
  modelMappings: [] as { from: string; to: string; enabled: boolean; route: "responses" | "messages" }[],
})
const formError = ref("")
const copyMessage = ref("")
const copiedProviderId = ref<string | null>(null)
let copyResetTimer: ReturnType<typeof window.setTimeout> | undefined
const draggedMappingIndex = ref<number | null>(null)
const selectedTargetModel = ref("")
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
        modelMappings: (provider.modelMappings ?? []).map((mapping) => ({
          ...mapping,
          enabled: mapping.enabled !== false,
          route: mapping.route === "messages" ? "messages" : "responses",
        })),
      }
    : { name: "", slug: "", baseUrl: "", enabled: true, routeOnly: false, modelMappings: [] }
  selectedTargetModel.value = ""
  formError.value = ""
  dialogOpen.value = true
}

function addMapping(): void {
  form.value.modelMappings.push({ from: "", to: "", enabled: true, route: "responses" })
}

function removeMapping(index: number): void {
  form.value.modelMappings.splice(index, 1)
}

function moveMapping(index: number, direction: -1 | 1): void {
  const destination = index + direction
  if (destination < 0 || destination >= form.value.modelMappings.length) return
  const [mapping] = form.value.modelMappings.splice(index, 1)
  form.value.modelMappings.splice(destination, 0, mapping)
}

function startMappingDrag(event: DragEvent, index: number): void {
  draggedMappingIndex.value = index
  event.dataTransfer?.setData("text/plain", String(index))
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
}

function dropMapping(index: number): void {
  const source = draggedMappingIndex.value
  draggedMappingIndex.value = null
  if (source === null || source === index) return
  const [mapping] = form.value.modelMappings.splice(source, 1)
  form.value.modelMappings.splice(index, 0, mapping)
}

const allMappingsEnabled = computed(() => form.value.modelMappings.length > 0 && form.value.modelMappings.every((mapping) => mapping.enabled))

function toggleAllMappings(): void {
  const enabled = !allMappingsEnabled.value
  for (const mapping of form.value.modelMappings) mapping.enabled = enabled
}

const targetModelChoices = computed(() => {
  const choices = new Set(["claude-sonnet-5", "gpt-5.6-terra"])
  for (const mapping of form.value.modelMappings) {
    if (mapping.to) choices.add(mapping.to)
  }
  return [...choices]
})

function applyTargetModel(): void {
  if (!selectedTargetModel.value) return
  for (const mapping of form.value.modelMappings) {
    if (mapping.enabled) mapping.to = selectedTargetModel.value
  }
}

async function clone(provider: Provider, mode: "route" | "mapping"): Promise<void> {
  const suffix = mode === "mapping" ? "-mapping-copy" : "-copy"
  const slug = window.prompt(t("cloneRouteSlug"), `${provider.slug}${suffix}`)?.trim()
  if (!slug) return
  try {
    await props.dashboard.cloneProvider(provider.id, { slug, mode })
  } catch (cause) {
    copyMessage.value = cause instanceof Error ? cause.message : String(cause)
  }
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

function routerUrl(provider: Provider): string {
  const current = window.location
  const routerPort = props.dashboard.router.value?.port ?? props.dashboard.config.value?.routerPort
  return providerRouterUrl(current, routerPort, provider.slug)
}

async function copyRouterUrl(provider: Provider): Promise<void> {
  const value = routerUrl(provider)
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value)
    else {
      const input = document.createElement("textarea")
      input.value = value
      input.style.position = "fixed"
      input.style.opacity = "0"
      document.body.append(input)
      input.select()
      if (!document.execCommand("copy")) throw new Error("Clipboard access was denied.")
      input.remove()
    }
    copiedProviderId.value = provider.id
    copyMessage.value = `${t("copiedRouterUrl")}: ${value}`
    if (copyResetTimer) window.clearTimeout(copyResetTimer)
    copyResetTimer = window.setTimeout(() => {
      copiedProviderId.value = null
      copyMessage.value = ""
    }, 1800)
  } catch {
    copyMessage.value = t("copyRouterUrlFailed")
  }
}
</script>

<template>
  <section class="page-grid">
    <div class="section-head page-heading">
      <div>
        <p>{{ t("providersHint") }}</p>
      </div>
      <button class="primary-button" type="button" @click="open()">
        <Plus :size="16" />
        {{ t("addProvider") }}
      </button>
    </div>
    <p v-if="copyMessage" class="copy-feedback" role="status" aria-live="polite">{{ copyMessage }}</p>
    <section class="surface table-surface">
      <div v-if="!dashboard.providers.value.length" class="empty">{{ t("noProviders") }}</div>
      <template v-else>
        <div class="table-head">
          <span>{{ t("providerName") }}</span>
          <span>{{ t("routeIdentifier") }}</span>
          <span>{{ t("upstreamUrl") }}</span>
          <span>{{ t("status") }}</span>
          <span>{{ t("mode") }}</span>
          <span>{{ t("actions") }}</span>
        </div>
        <div v-for="provider in dashboard.providers.value" :key="provider.id" class="table-row">
          <strong>{{ provider.name }}</strong>
          <div class="route-id-cell">
            <code>{{ provider.slug }}</code>
            <button
              class="icon-button"
              type="button"
              :title="copiedProviderId === provider.id ? t('copiedRouterUrl') : t('copyRouterUrl')"
              :aria-label="copiedProviderId === provider.id ? t('copiedRouterUrl') : t('copyRouterUrl')"
              @click="copyRouterUrl(provider)"
            >
              <Check v-if="copiedProviderId === provider.id" :size="15" />
              <Copy v-else :size="15" />
            </button>
          </div>
          <span class="truncate mono">{{ provider.baseUrl }}</span>
          <span class="status-badge" :class="provider.enabled ? 'running' : 'stopped'">
            {{ provider.enabled ? t("enabled") : t("disabled") }}
          </span>
          <span>{{ provider.routeOnly ? t("routeOnly") : t("conversion") }}</span>
          <div class="row-actions">
            <button
              class="icon-button"
              type="button"
              :title="t('cloneRoute')"
              :aria-label="t('cloneRoute')"
              @click="clone(provider, 'route')"
            >
              <CopyPlus :size="15" />
            </button>
            <button
              class="icon-button"
              type="button"
              :title="t('cloneMapping')"
              :aria-label="t('cloneMapping')"
              @click="clone(provider, 'mapping')"
            >
              <Copy :size="15" />
            </button>
            <button
              class="icon-button"
              type="button"
              :title="t('edit')"
              :aria-label="t('edit')"
              @click="open(provider)"
            >
              <Pencil :size="15" />
            </button>
            <button
              class="icon-button danger-button"
              type="button"
              :title="t('delete')"
              :aria-label="t('delete')"
              @click="remove(provider)"
            >
              <Trash2 :size="15" />
            </button>
          </div>
        </div>
      </template>
    </section>
    <Teleport to="body">
      <div v-if="dialogOpen" class="dialog-layer" role="presentation" @click.self="dialogOpen = false">
        <dialog open class="dialog" role="dialog" aria-modal="true" :aria-label="editing ? t('editProvider') : t('addProvider')">
          <form @submit.prevent="save">
        <div class="dialog-head">
          <h2>{{ editing ? t("editProvider") : t("addProvider") }}</h2>
          <button class="icon-button" type="button" :aria-label="t('close')" @click="dialogOpen = false">
            <X :size="16" />
          </button>
        </div>
        <label>
          {{ t("providerName") }}
          <input v-model.trim="form.name" required autocomplete="off">
        </label>
        <label>
          {{ t("routeIdentifier") }}
          <input v-model.trim="form.slug" required pattern="[A-Za-z0-9_-]+" autocomplete="off">
        </label>
        <label>
          {{ t("baseUrl") }}
          <input v-model.trim="form.baseUrl" required type="url" placeholder="https://example.com/v1">
        </label>
        <label class="toggle-row">
          <span>
            <b>{{ t("enabled") }}</b>
            <small>{{ t("acceptProvider") }}</small>
          </span>
          <input v-model="form.enabled" type="checkbox">
          <i />
        </label>
        <fieldset class="mapping-fieldset">
          <legend>
            {{ t("modelMappings") }}
            <button class="mapping-toggle-all" type="button" :disabled="form.modelMappings.length === 0" @click="toggleAllMappings">
              <Power :size="13" /> {{ allMappingsEnabled ? t("disableAllMappings") : t("enableAllMappings") }}
            </button>
          </legend>
          <small>{{ t("modelMappingsHint") }}</small>
          <datalist id="provider-target-models">
            <option v-for="model in targetModelChoices" :key="model" :value="model" />
          </datalist>
          <label v-if="form.modelMappings.length" class="mapping-target-control">
            <span>{{ t("bulkTargetModel") }}</span>
            <select v-model="selectedTargetModel" @change="applyTargetModel">
              <option value="" disabled>{{ t("selectTargetModel") }}</option>
              <option v-for="model in targetModelChoices" :key="model" :value="model">{{ model }}</option>
            </select>
            <small>{{ t("bulkTargetModelHint") }}</small>
          </label>
          <div
            v-for="(mapping, index) in form.modelMappings"
            :key="index"
            class="mapping-row"
            :class="{ 'is-dragging': draggedMappingIndex === index }"
            @dragover.prevent
            @drop="dropMapping(index)"
          >
            <button
              class="icon-button drag-handle"
              type="button"
              draggable="true"
              :title="t('dragToReorder')"
              @dragstart="startMappingDrag($event, index)"
              @dragend="draggedMappingIndex = null"
            >
              <GripVertical :size="14" />
            </button>
            <input v-model.trim="mapping.from" required placeholder="source-model, prefix*, or ?" autocomplete="off">
            <span>→</span>
            <input
              v-model.trim="mapping.to"
              required
              list="provider-target-models"
              :placeholder="t('individualTargetModel')"
              autocomplete="off"
            >
            <select v-model="mapping.route" :aria-label="t('mappingRoute')">
              <option value="responses">{{ t("responsesRoute") }}</option>
              <option value="messages">{{ t("messagesRoute") }}</option>
            </select>
            <button class="icon-button mapping-toggle" :class="{ 'is-disabled': !mapping.enabled }" type="button" :title="mapping.enabled ? t('disableMapping') : t('enableMapping')" @click="mapping.enabled = !mapping.enabled">
              <Power :size="14" />
            </button>
            <button class="icon-button" type="button" :title="t('moveUp')" :disabled="index === 0" @click="moveMapping(index, -1)">
              <ChevronUp :size="14" />
            </button>
            <button class="icon-button" type="button" :title="t('moveDown')" :disabled="index === form.modelMappings.length - 1" @click="moveMapping(index, 1)">
              <ChevronDown :size="14" />
            </button>
            <button class="icon-button danger-button" type="button" :title="t('delete')" @click="removeMapping(index)">
              <Trash2 :size="14" />
            </button>
          </div>
          <button class="secondary-button" type="button" @click="addMapping"><Plus :size="14" /> {{ t("addMapping") }}</button>
        </fieldset>
        <label class="toggle-row">
          <span>
            <b>{{ t("routeOnly") }}</b>
            <small>{{ t("routeOnlyHint") }}</small>
          </span>
          <input v-model="form.routeOnly" type="checkbox">
          <i />
        </label>
        <p v-if="formError" class="form-error" role="alert">{{ formError }}</p>
        <div class="dialog-actions">
          <button type="button" @click="dialogOpen = false">{{ t("cancelDialog") }}</button>
          <button class="primary-button" type="submit">{{ t("saveProvider") }}</button>
        </div>
          </form>
        </dialog>
      </div>
    </Teleport>
  </section>
</template>
