import { useCookie } from "nuxt/app"
import { computed } from "vue"
import { type Locale, translate } from "~/utils/locale"

export function useLocale() {
  const locale = useCookie<Locale>("codex-router-locale", {
    default: () => "zh-Hant",
    sameSite: "lax",
  })
  const language = computed(() => locale.value)
  const t = (key: string): string => translate(language.value, key)
  return { locale, t }
}
