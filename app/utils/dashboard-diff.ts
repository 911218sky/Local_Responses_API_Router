import type { DiffLine } from "./dashboard-types"

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
