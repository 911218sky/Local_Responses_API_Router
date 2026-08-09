import { expect, test } from "bun:test"
import { changeLabels, formatPayload } from "../../app/utils/session-detail"
import { matchesSessionKey } from "../dashboard/sessions"

test("Given an unscoped session, When its synthetic dashboard key is resolved, Then the session remains addressable", () => {
  expect(matchesSessionKey(null, "unknown")).toBe(true)
  expect(matchesSessionKey(undefined, "unknown")).toBe(true)
  expect(matchesSessionKey("session-1", "unknown")).toBe(false)
})

test("Given a transformed request, When its detail is rendered, Then change labels are available", () => {
  const labels = changeLabels({
    id: "request-1",
    createdAt: "2026-08-09T00:00:00.000Z",
    status: "success",
    transform: {
      mode: "continuation",
      operations: [
        { type: "transformed", scope: "body", label: "恢復已保存上下文" },
        { type: "added", scope: "headers", label: "加入 session-id" },
      ],
    },
  })

  expect(labels).toEqual(["恢復已保存上下文", "加入 session-id"])
})

test("Given a payload, When it is rendered, Then it remains readable JSON", () => {
  expect(formatPayload({ input: [{ role: "user", content: "hello" }] })).toBe(
    '{\n  "input": [\n    {\n      "role": "user",\n      "content": "hello"\n    }\n  ]\n}',
  )
})
