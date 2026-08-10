import { computed, onMounted, readonly, ref } from "vue"
import type { ProviderTestError, ProviderTestPreset } from "~/types"

interface ModelsResponse {
  models: string[]
}

interface MessageResponse {
  model: string
  answer: string
}

export function useProviderTest() {
  const presets = ref<ProviderTestPreset[]>([])
  const models = ref<string[]>([])
  const loadingPresets = ref(false)
  const loadingModels = ref(false)
  const sending = ref(false)
  const error = ref<ProviderTestError | null>(null)
  const answer = ref("")
  const testedModel = ref("")

  async function loadPresets(): Promise<void> {
    loadingPresets.value = true
    try {
      const response = await $fetch<{ presets: ProviderTestPreset[] }>("/api/provider-tests/presets")
      presets.value = response.presets
    } catch (cause) {
      error.value = normalizeError(cause)
    } finally {
      loadingPresets.value = false
    }
  }

  async function loadModels(input: Record<string, unknown>): Promise<string[]> {
    loadingModels.value = true
    error.value = null
    answer.value = ""
    models.value = []
    try {
      const response = await $fetch<ModelsResponse>("/api/provider-tests/models", { method: "POST", body: input })
      models.value = response.models
      return response.models
    } catch (cause) {
      error.value = normalizeError(cause)
      return []
    } finally {
      loadingModels.value = false
    }
  }

  async function sendMessage(input: Record<string, unknown>): Promise<boolean> {
    sending.value = true
    error.value = null
    answer.value = ""
    try {
      const response = await $fetch<MessageResponse>("/api/provider-tests/message", { method: "POST", body: input })
      answer.value = response.answer
      testedModel.value = response.model
      return true
    } catch (cause) {
      error.value = normalizeError(cause)
      return false
    } finally {
      sending.value = false
    }
  }

  onMounted(() => void loadPresets())
  return {
    presets: readonly(presets),
    models: readonly(models),
    loadingPresets: readonly(loadingPresets),
    loadingModels: readonly(loadingModels),
    sending: readonly(sending),
    error: readonly(error),
    answer: readonly(answer),
    testedModel: readonly(testedModel),
    loadModels,
    sendMessage,
    clearError: () => {
      error.value = null
    },
    hasAnswer: computed(() => answer.value.length > 0),
  }
}

function normalizeError(cause: unknown): ProviderTestError {
  const value = isRecord(cause) ? cause : {}
  const data = isRecord(value.data) ? value.data : {}
  const nestedData = isRecord(data.data) ? data.data : {}
  const code = isProviderTestCode(data.code)
    ? data.code
    : isProviderTestCode(nestedData.code)
      ? nestedData.code
      : "upstream_error"
  const message =
    typeof data.message === "string"
      ? data.message
      : typeof nestedData.message === "string"
        ? nestedData.message
        : typeof value.statusMessage === "string"
          ? value.statusMessage
          : "The provider test failed."
  return { code, message, ...(typeof value.statusCode === "number" ? { status: value.statusCode } : {}) }
}

function isProviderTestCode(value: unknown): value is ProviderTestError["code"] {
  return (
    value === "invalid_input" ||
    value === "invalid_key" ||
    value === "invalid_base_url" ||
    value === "model_not_found" ||
    value === "timeout" ||
    value === "unavailable" ||
    value === "upstream_error"
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
