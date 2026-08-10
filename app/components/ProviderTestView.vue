<script setup lang="ts">
import {
  CheckCircle2,
  FlaskConical,
  KeyRound,
  LoaderCircle,
  MessageSquareText,
  Save,
  Send,
  ShieldCheck,
  Wifi,
} from "lucide-vue-next"
import { computed, ref, watch } from "vue"
import { useLocale } from "~/composables/useLocale"
import { useProviderTest } from "~/composables/useProviderTest"
import { resolveProviderName } from "~/utils/provider-test"
import { publicRouterUrl } from "~/utils/router-url"

const props = defineProps<{ dashboard: ReturnType<typeof import("~/composables/useDashboard").useDashboard> }>()
const { t } = useLocale()
const test = useProviderTest()
const presetId = ref("openai")
const baseUrl = ref("")
const apiKey = ref("")
const selectedModel = ref("")
const prompt = ref("")
const providerName = ref("")
const timeoutSeconds = ref(20)
const saved = ref(false)
const saveError = ref("")

const preset = computed(() => test.presets.value.find((item) => item.id === presetId.value) ?? null)
const keyRequired = computed(() => preset.value?.apiKeyRequired !== false)
const canLoadModels = computed(
  () => baseUrl.value.trim().length > 0 && (!keyRequired.value || apiKey.value.trim().length > 0),
)
const canSend = computed(() => selectedModel.value.length > 0 && prompt.value.trim().length > 0 && !test.sending.value)
const resultState = computed(() => (test.hasAnswer.value ? "success" : test.error.value ? "error" : "idle"))

watch(
  () => test.presets.value,
  (items) => {
    if (!items.length || !items.some((item) => item.id === presetId.value)) return
    const next = items.find((item) => item.id === presetId.value)
    if (next && !baseUrl.value) baseUrl.value = next.baseUrl
  },
  { immediate: true },
)

watch(presetId, (nextId) => {
  const next = test.presets.value.find((item) => item.id === nextId)
  baseUrl.value = next?.baseUrl ?? ""
  selectedModel.value = ""
  saved.value = false
  test.clearError()
})

async function loadModels(): Promise<void> {
  const requestBaseUrl = normalizeRouterUrl()
  selectedModel.value = ""
  saved.value = false
  await test.loadModels({
    presetId: presetId.value,
    baseUrl: requestBaseUrl,
    apiKey: apiKey.value,
    timeoutSeconds: timeoutSeconds.value,
  })
  selectedModel.value = test.models.value[0] ?? ""
}

async function sendMessage(): Promise<void> {
  if (!canSend.value) return
  const requestBaseUrl = normalizeRouterUrl()
  saved.value = false
  await test.sendMessage({
    presetId: presetId.value,
    baseUrl: requestBaseUrl,
    apiKey: apiKey.value,
    model: selectedModel.value,
    prompt: prompt.value,
    timeoutSeconds: timeoutSeconds.value,
  })
}

function normalizeRouterUrl(): string {
  if (typeof window === "undefined") return baseUrl.value
  const routerPort = props.dashboard.router.value?.port ?? props.dashboard.config.value?.routerPort
  const normalized = publicRouterUrl(baseUrl.value, window.location, routerPort)
  if (normalized !== baseUrl.value) baseUrl.value = normalized
  return normalized
}

async function saveProvider(): Promise<void> {
  if (!test.hasAnswer.value) return
  saveError.value = ""
  try {
    const name = resolveProviderName(providerName.value, preset.value?.name, t("customProvider"))
    await props.dashboard.addProvider({
      name,
      slug: uniqueSlug(name, baseUrl.value),
      baseUrl: baseUrl.value.trim().replace(/\/$/, ""),
      enabled: true,
      routeOnly: false,
    })
    saved.value = true
  } catch (cause) {
    saveError.value = cause instanceof Error ? cause.message : String(cause)
  }
}

function uniqueSlug(name: string, url: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "provider"
  const collision = props.dashboard.providers.value.some((item) => item.slug === base)
  if (!collision) return base
  try {
    const host = new URL(url).hostname.split(".")[0]
    return `${base}-${host}`.replace(/[^a-z0-9_-]/g, "-").slice(0, 48)
  } catch {
    return `${base}-test`
  }
}
</script>

<template>
  <section class="page-grid provider-test-page">
    <div class="test-hero">
      <div>
        <span class="eyebrow"><FlaskConical :size="15" aria-hidden="true" /> {{ t("testCenter") }}</span>
        <h2>{{ t("testCenterTitle") }}</h2>
        <p>{{ t("testCenterHint") }}</p>
      </div>
      <div class="test-hero-note"><ShieldCheck :size="18" aria-hidden="true" /><span>{{ t("keyPrivacy") }}</span></div>
    </div>

    <div class="test-workspace">
      <form class="surface test-form" @submit.prevent="sendMessage">
        <div class="panel-title"><div><strong>{{ t("connectionSetup") }}</strong><small>{{ t("connectionSetupHint") }}</small></div><Wifi class="test-panel-icon" :size="20" aria-hidden="true" /></div>
        <label class="field-label">
          {{ t("testProvider") }}
          <select v-model="presetId" :disabled="test.loadingPresets.value">
            <option v-for="item in test.presets.value" :key="item.id" :value="item.id">{{ item.name }}</option>
          </select>
          <small v-if="preset">{{ preset.description }}</small>
        </label>
        <label class="field-label">
          {{ t("testBaseUrl") }}
          <input v-model.trim="baseUrl" type="url" required autocomplete="url" placeholder="https://api.example.com/v1">
        </label>
        <label class="field-label">
          <span class="label-with-icon"><KeyRound :size="14" aria-hidden="true" /> {{ t("testApiKey") }} <em v-if="!keyRequired">{{ t("optional") }}</em></span>
          <input v-model="apiKey" type="password" :required="keyRequired" autocomplete="off" :placeholder="keyRequired ? t('apiKeyPlaceholder') : t('noKeyRequired')">
          <small>{{ t("keyPrivacy") }}</small>
        </label>
        <label class="field-label compact-field">
          {{ t("testTimeout") }}
          <span class="input-suffix"><input v-model.number="timeoutSeconds" type="number" min="5" max="120" step="1"><span>{{ t("seconds") }}</span></span>
        </label>
        <button class="primary-button wide-button" type="button" :disabled="!canLoadModels || test.loadingModels.value" @click="loadModels">
          <LoaderCircle v-if="test.loadingModels.value" class="spin" :size="16" aria-hidden="true" />
          <Wifi v-else :size="16" aria-hidden="true" />
          {{ test.loadingModels.value ? t("loadingModels") : t("loadModels") }}
        </button>
        <div v-if="test.models.value.length" class="model-picker">
          <label class="field-label">
            {{ t("testModel") }}
            <select v-model="selectedModel" required>
              <option v-for="model in test.models.value" :key="model" :value="model">{{ model }}</option>
            </select>
          </label>
          <span class="model-count">{{ test.models.value.length }} {{ t("modelsFound") }}</span>
        </div>
      </form>

      <form class="surface test-message" @submit.prevent="sendMessage">
        <div class="panel-title"><div><strong>{{ t("sendTestMessage") }}</strong><small>{{ t("sendTestMessageHint") }}</small></div><MessageSquareText class="test-panel-icon" :size="20" aria-hidden="true" /></div>
        <label class="field-label message-field">
          {{ t("testQuestion") }}
          <textarea v-model.trim="prompt" rows="7" required :placeholder="t('testQuestionPlaceholder')" />
        </label>
        <label class="field-label">
          {{ t("savedProviderName") }}
          <input v-model.trim="providerName" autocomplete="organization" :placeholder="preset?.name || t('customProvider')">
          <small>{{ t("savedProviderNameHint") }}</small>
        </label>
        <button class="primary-button wide-button" type="submit" :disabled="!canSend">
          <LoaderCircle v-if="test.sending.value" class="spin" :size="16" aria-hidden="true" />
          <Send v-else :size="16" aria-hidden="true" />
          {{ test.sending.value ? t("sendingTest") : t("sendTest") }}
        </button>
        <div class="test-result" :class="`result-${resultState}`" aria-live="polite">
          <template v-if="resultState === 'success'">
            <div class="result-heading"><CheckCircle2 class="result-success-icon" :size="19" aria-hidden="true" /><strong>{{ t("connectionSuccess") }}</strong><span>{{ test.testedModel.value }}</span></div>
            <p class="answer">{{ test.answer.value }}</p>
            <button class="small-button" type="button" :disabled="saved || props.dashboard.busy.value" @click="saveProvider">
              <CheckCircle2 v-if="saved" :size="15" aria-hidden="true" /><Save v-else :size="15" aria-hidden="true" />
              {{ saved ? t("providerSaved") : t("saveAsProvider") }}
            </button>
            <p v-if="saveError" class="form-error inline-error" role="alert">{{ saveError }}</p>
          </template>
          <template v-else-if="resultState === 'error'">
            <div class="result-heading"><span class="result-icon error-icon">!</span><strong>{{ t("connectionFailed") }}</strong><span v-if="test.error.value?.code" class="error-code">{{ test.error.value.code }}</span></div>
            <p class="answer error-copy">{{ test.error.value?.message }}</p>
          </template>
          <div v-else class="result-empty"><span class="result-icon"><Wifi :size="17" aria-hidden="true" /></span><span>{{ t("resultWaiting") }}</span></div>
        </div>
      </form>
    </div>
  </section>
</template>
