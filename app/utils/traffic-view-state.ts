import { type Ref, type WatchHandle, watch } from "vue"
import type { Session } from "~/types"

export function shouldShowSessionLoading(detailBusy: boolean, hasDetail: boolean): boolean {
  return detailBusy && !hasDetail
}

export function watchSelectedSessionId(
  selected: Readonly<Ref<Session | null>>,
  onSessionChanged: () => void,
): WatchHandle {
  return watch(() => selected.value?.sessionId, onSessionChanged)
}
