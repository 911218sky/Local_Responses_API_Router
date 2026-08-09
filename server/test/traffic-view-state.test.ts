import { expect, test } from "bun:test"
import { nextTick, ref } from "vue"
import { shouldShowSessionLoading, watchSelectedSessionId } from "../../app/utils/traffic-view-state"

test("Given existing session detail, When polling is busy, Then detail stays mounted", () => {
  expect(shouldShowSessionLoading(true, true)).toBe(false)
  expect(shouldShowSessionLoading(true, false)).toBe(true)
})

function session(sessionId: string, count: number) {
  return {
    sessionId,
    provider: null,
    label: null,
    imported: false,
    count,
    updatedAt: "2026-08-09T00:00:00.000Z",
    responseIds: [],
  }
}

test("Given a polled replacement object, When its session ID is unchanged, Then expanded state is preserved", async () => {
  const selected = ref(session("session-1", 1))
  let resetCount = 0
  const stop = watchSelectedSessionId(selected, () => {
    resetCount += 1
  })

  selected.value = session("session-1", 2)
  await nextTick()

  expect(resetCount).toBe(0)
  stop()
})

test("Given a selected session, When its session ID changes, Then expanded state is reset", async () => {
  const selected = ref(session("session-1", 1))
  let resetCount = 0
  const stop = watchSelectedSessionId(selected, () => {
    resetCount += 1
  })

  selected.value = session("session-2", 1)
  await nextTick()

  expect(resetCount).toBe(1)
  stop()
})
