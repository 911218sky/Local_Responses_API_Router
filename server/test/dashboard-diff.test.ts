import { expect, test } from "bun:test"
import {
  alignDiffRows,
  buildPayloadDiffPairs,
  buildPayloadDiffRows,
  classifyDiffRow,
} from "../../app/utils/dashboard-diff"
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

test("Given an input key removed from the outgoing payload, When payload diff rows are built, Then the old value is marked removed", () => {
  const rows = buildPayloadDiffRows(
    { input: [{ role: "user", content: "hello" }], metadata: { trace: "local" } },
    { input: [{ role: "user", content: "hello" }] },
  )

  expect(rows).toContainEqual({
    key: "$.metadata.trace",
    value: '"local"',
    kind: "removed",
    depth: 2,
    side: "left",
  })
})

test("Given an outgoing key added by transformation, When payload diff rows are built, Then the new value is marked added", () => {
  const rows = buildPayloadDiffRows({ input: [] }, { input: [], metadata: { source: "router" } })

  expect(rows).toContainEqual({
    key: "$.metadata.source",
    value: '"router"',
    kind: "added",
    depth: 2,
    side: "right",
  })
})

test("Given a scalar value changed in place, When payload diff rows are built, Then old and new rows are emitted in red/green order", () => {
  const rows = buildPayloadDiffRows({ model: "gpt-4.1" }, { model: "gpt-5" })

  expect(rows).toEqual([
    { key: "$.model", value: '"gpt-4.1"', kind: "removed", depth: 1, side: "left" },
    { key: "$.model", value: '"gpt-5"', kind: "added", depth: 1, side: "right" },
  ])
})

test("Given array entries beyond index nine, When payload diff rows are built, Then numeric indices stay in source order", () => {
  const rows = buildPayloadDiffRows(
    { input: Array.from({ length: 12 }, (_, index) => ({ index })) },
    { input: Array.from({ length: 12 }, (_, index) => ({ index })) },
  )

  expect(rows.filter((row) => row.key.startsWith("$.input[")).map((row) => row.key)).toEqual(
    Array.from({ length: 12 }, (_, index) => `$.input[${index}].index`),
  )
})

test("Given removed and added rows for one key, When split diff pairs are built, Then both sides share one readable row", () => {
  const rows = buildPayloadDiffRows({ model: "gpt-4.1" }, { model: "gpt-5" })

  expect(buildPayloadDiffPairs(rows)).toEqual([
    {
      key: "$.model",
      kind: "changed",
      left: { key: "$.model", value: '"gpt-4.1"', kind: "removed", depth: 1, side: "left" },
      right: { key: "$.model", value: '"gpt-5"', kind: "added", depth: 1, side: "right" },
    },
  ])
})
