import { expect, test } from "bun:test"
import { parseDashboardResponse } from "../../app/utils/dashboard-api"

test("Given a successful empty API response, When it is parsed, Then it resolves without attempting JSON parsing", async () => {
  const response = new Response(null, { status: 204 })

  const result = await parseDashboardResponse(response)

  expect(result).toBeUndefined()
})
