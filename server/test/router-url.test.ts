import { expect, test } from "bun:test"
import { providerRouterRouteFormat, providerRouterUrl, publicRouterUrl } from "../../app/utils/router-url"

test("Given a local dashboard URL, When formatting a provider route, Then the router port is preserved", () => {
  const current = new URL("http://127.0.0.1:38129/")

  expect(providerRouterUrl(current, 38128, "custom-provider")).toBe("http://127.0.0.1:38128/custom-provider/v1")
  expect(providerRouterRouteFormat(current, 38128)).toBe("http://127.0.0.1:38128/{provider}/v1/responses")
})

test("Given a public dashboard URL, When formatting a provider route, Then the displayed route uses the current origin", () => {
  const current = new URL("https://router.example.com/dashboard")

  expect(providerRouterUrl(current, 38128, "custom-provider")).toBe("https://router.example.com/custom-provider/v1")
  expect(providerRouterRouteFormat(current, 38128)).toBe("https://router.example.com/{provider}/v1/responses")
})

test("Given a public dashboard URL with a non-default port, When formatting a provider route, Then that port remains visible", () => {
  const current = new URL("https://router.example.com:8443/dashboard")

  expect(providerRouterUrl(current, 38128, "custom-provider")).toBe(
    "https://router.example.com:8443/custom-provider/v1",
  )
})

test("Given a public dashboard URL and a pasted local router URL, When normalizing the test target, Then the current public origin is used", () => {
  const current = new URL("https://llm-router.sky1218.com/")

  expect(publicRouterUrl("http://127.0.0.1:38128/easytokencc/v1", current, 38128)).toBe(
    "https://llm-router.sky1218.com/easytokencc/v1",
  )
})

test("Given a public dashboard URL and a local non-router URL, When normalizing the test target, Then the local service URL is preserved", () => {
  const current = new URL("https://llm-router.sky1218.com/")

  expect(publicRouterUrl("http://127.0.0.1:11434/v1", current, 38128)).toBe("http://127.0.0.1:11434/v1")
})
