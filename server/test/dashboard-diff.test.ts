import { expect, test } from "bun:test"
import { alignDiffRows, classifyDiffRow } from "../../app/utils/dashboard-diff"
import type { DiffLine } from "../../app/utils/dashboard-types"

test("Given a replayed input item, When its diff row is classified, Then it is marked as replayed", () => {
  const row: DiffLine = { key: "$.input[0]", depth: 2, text: "input: restored", value: "restored", structural: false }

  const type = classifyDiffRow({ left: row, right: row }, "body", {
    continuation: { historyStartIndex: 0, historyItemCount: 1 },
  })

  expect(type).toBe("replayed")
})

test("Given a value moved to another path, When diff rows are aligned, Then the row is marked as remapped", () => {
  const left: DiffLine = {
    key: "$.source",
    depth: 1,
    text: "source: same value",
    value: "same value",
    structural: false,
  }
  const right: DiffLine = {
    key: "$.target",
    depth: 1,
    text: "target: same value",
    value: "same value",
    structural: false,
  }

  const [aligned] = alignDiffRows([left], [right])

  expect(aligned?.remapped).toBeTrue()
})
