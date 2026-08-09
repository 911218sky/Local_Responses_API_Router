import type { DiffLine } from "./dashboard-types"

export type PayloadDiffKind = "added" | "removed" | "unchanged"
export type PayloadDiffSide = "left" | "right" | "both"
export type PayloadDiffPairKind = "added" | "removed" | "changed" | "unchanged"

export interface PayloadDiffRow {
  readonly key: string
  readonly value: string
  readonly kind: PayloadDiffKind
  readonly depth: number
  readonly side: PayloadDiffSide
}

export interface PayloadDiffPair {
  readonly key: string
  readonly kind: PayloadDiffPairKind
  readonly left?: PayloadDiffRow
  readonly right?: PayloadDiffRow
}

export interface AlignedDiffRow {
  readonly left?: DiffLine
  readonly right?: DiffLine
  readonly remapped?: boolean
}

export interface ContinuationDiff {
  readonly continuation?: {
    readonly historyStartIndex: number
    readonly historyItemCount: number
  }
}

interface FlattenedPayloadValue {
  readonly key: string
  readonly value: string
  readonly depth: number
}

export function alignDiffRows(left: readonly DiffLine[], right: readonly DiffLine[]): AlignedDiffRow[] {
  return Array.from({ length: Math.max(left.length, right.length) }, (_, index) => {
    const leftRow = left[index]
    const rightRow = right[index]
    const remapped = leftRow?.value !== undefined && leftRow.value === rightRow?.value && leftRow.key !== rightRow.key
    return {
      ...(leftRow ? { left: leftRow } : {}),
      ...(rightRow ? { right: rightRow } : {}),
      ...(remapped ? { remapped: true } : {}),
    }
  })
}

export function classifyDiffRow(row: AlignedDiffRow, scope: string, trace: ContinuationDiff): string {
  const history = trace.continuation
  const key = row.left?.key ?? row.right?.key ?? ""
  if (scope === "body" && history && key.startsWith("$.input[")) return "replayed"
  if (row.remapped) return "remapped"
  return row.left && row.right ? "unchanged" : row.left ? "removed" : "added"
}

export function buildPayloadDiffRows(left: unknown, right: unknown): PayloadDiffRow[] {
  const leftValues = new Map(flattenPayload(left).map((entry) => [entry.key, entry] as const))
  const rightValues = new Map(flattenPayload(right).map((entry) => [entry.key, entry] as const))
  const keys = [...new Set([...leftValues.keys(), ...rightValues.keys()])].sort(comparePayloadKeys)
  const rows: PayloadDiffRow[] = []

  for (const key of keys) {
    const leftValue = leftValues.get(key)
    const rightValue = rightValues.get(key)
    if (leftValue && rightValue) {
      if (leftValue.value === rightValue.value) {
        rows.push({ ...rightValue, kind: "unchanged", side: "both" })
      } else {
        rows.push({ ...leftValue, kind: "removed", side: "left" })
        rows.push({ ...rightValue, kind: "added", side: "right" })
      }
      continue
    }
    if (leftValue) rows.push({ ...leftValue, kind: "removed", side: "left" })
    if (rightValue) rows.push({ ...rightValue, kind: "added", side: "right" })
  }

  return rows
}

export function buildPayloadDiffPairs(rows: readonly PayloadDiffRow[]): PayloadDiffPair[] {
  const pairs: PayloadDiffPair[] = []

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (!row) continue

    const next = rows[index + 1]
    if (row.kind === "removed" && next?.kind === "added" && next.key === row.key) {
      pairs.push({ key: row.key, kind: "changed", left: row, right: next })
      index += 1
      continue
    }

    if (row.kind === "removed") {
      pairs.push({ key: row.key, kind: "removed", left: row })
      continue
    }

    if (row.kind === "added") {
      pairs.push({ key: row.key, kind: "added", right: row })
      continue
    }

    pairs.push({ key: row.key, kind: "unchanged", left: row, right: row })
  }

  return pairs
}

function comparePayloadKeys(left: string, right: string): number {
  const leftTokens = payloadKeyTokens(left)
  const rightTokens = payloadKeyTokens(right)
  const length = Math.max(leftTokens.length, rightTokens.length)
  for (let index = 0; index < length; index += 1) {
    const leftToken = leftTokens[index]
    const rightToken = rightTokens[index]
    if (leftToken === undefined) return -1
    if (rightToken === undefined) return 1
    if (typeof leftToken === "number" && typeof rightToken === "number") {
      if (leftToken !== rightToken) return leftToken - rightToken
      continue
    }
    const comparison = String(leftToken).localeCompare(String(rightToken))
    if (comparison !== 0) return comparison
  }
  return 0
}

function payloadKeyTokens(key: string): Array<string | number> {
  return (key.match(/\$|[A-Za-z_$][\w$]*|\[\d+\]|\[".*"\]/g) ?? []).map((token) =>
    /^\[\d+\]$/.test(token) ? Number(token.slice(1, -1)) : token,
  )
}

function flattenPayload(value: unknown, key = "$", depth = 0): FlattenedPayloadValue[] {
  if (Array.isArray(value)) {
    if (!value.length) return [{ key, value: "[]", depth }]
    return value.flatMap((item, index) => flattenPayload(item, `${key}[${index}]`, depth + 1))
  }

  if (isRecord(value)) {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    if (!entries.length) return [{ key, value: "{}", depth }]
    return entries.flatMap(([childKey, childValue]) =>
      flattenPayload(childValue, appendObjectKey(key, childKey), depth + 1),
    )
  }

  return [{ key, value: formatDiffValue(value), depth }]
}

function appendObjectKey(parent: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`
}

function formatDiffValue(value: unknown): string {
  const serialized = JSON.stringify(value)
  return serialized === undefined ? String(value) : serialized
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
