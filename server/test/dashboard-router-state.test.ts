import { expect, test } from "bun:test"
import { routerPresentation } from "../../app/utils/dashboard-router-state"

test("Given a running router, When presenting its state, Then the status and control both describe stopping", () => {
  const presentation = routerPresentation(true)

  expect(presentation.statusKey).toBe("Router running")
  expect(presentation.toggleKey).toBe("Stop router")
  expect(presentation.statusClass).toBe("running")
})

test("Given a stopped router, When presenting its state, Then the status and control both describe starting", () => {
  const presentation = routerPresentation(false)

  expect(presentation.statusKey).toBe("Router stopped")
  expect(presentation.toggleKey).toBe("Start router")
  expect(presentation.statusClass).toBe("stopped")
})
