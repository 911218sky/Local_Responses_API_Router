import type { RequestLog } from "~/types"

export function changeLabels(log: RequestLog): string[] {
  return log.transform?.operations.map((operation) => operation.label) ?? []
}

export function formatPayload(value: unknown): string {
  if (value === undefined) return ""
  return JSON.stringify(value, null, 2) ?? String(value)
}
