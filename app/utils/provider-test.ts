export function resolveProviderName(customName: string, presetName: string | undefined, fallback: string): string {
  const enteredName = customName.trim()
  if (enteredName) return enteredName
  const availablePresetName = presetName?.trim()
  return availablePresetName || fallback
}
