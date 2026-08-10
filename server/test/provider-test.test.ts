import { expect, test } from "bun:test"
import { resolveProviderName } from "../../app/utils/provider-test"
import { listProviderModels, sendProviderTestMessage } from "../dashboard/provider-test"

const originalFetch = globalThis.fetch

test("Given a custom provider name, When a test provider is saved, Then the custom name wins over the preset name", () => {
  expect(resolveProviderName("  My Gateway  ", "OpenAI", "Custom provider")).toBe("My Gateway")
  expect(resolveProviderName("   ", "OpenAI", "Custom provider")).toBe("OpenAI")
  expect(resolveProviderName("", undefined, "Custom provider")).toBe("Custom provider")
})

test("Given an OpenAI-compatible provider, When models are requested, Then the test endpoint returns model ids without router logs", async () => {
  let calledUrl = ""
  let calledHeaders: HeadersInit | undefined
  mockFetch(async (input, init) => {
    calledUrl = String(input)
    calledHeaders = init?.headers
    return Response.json({ data: [{ id: "gpt-test" }, { id: "mini-test" }] })
  })
  try {
    const result = await listProviderModels({ presetId: "openai", apiKey: "secret-key" })
    expect(result.models).toEqual(["gpt-test", "mini-test"])
    expect(calledUrl).toBe("https://api.openai.com/v1/models")
    expect(new Headers(calledHeaders).get("authorization")).toBe("Bearer secret-key")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("Given an Anthropic provider, When a test question is sent, Then the answer is extracted from the message content", async () => {
  let requestBody = ""
  mockFetch(async (_input, init) => {
    requestBody = typeof init?.body === "string" ? init.body : ""
    return Response.json({ content: [{ type: "text", text: "A safe test answer" }] })
  })
  try {
    const result = await sendProviderTestMessage({
      presetId: "anthropic",
      apiKey: "secret-key",
      model: "claude-test",
      prompt: "Hello",
    })
    expect(result).toEqual({ model: "claude-test", answer: "A safe test answer" })
    expect(requestBody).not.toContain("secret-key")
    expect(JSON.parse(requestBody).messages[0].content).toBe("Hello")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("Given a rejected key, When the provider responds with unauthorized, Then a safe classified error is returned", async () => {
  mockFetch(async () => new Response(JSON.stringify({ error: "secret-key is invalid" }), { status: 401 }))
  try {
    await expect(listProviderModels({ presetId: "openai", apiKey: "secret-key" })).rejects.toMatchObject({
      statusCode: 401,
      data: { code: "invalid_key", message: "The API Key was rejected by the provider." },
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("Given a custom provider without a base URL, When models are requested, Then input is rejected before network access", async () => {
  let called = false
  mockFetch(async () => {
    called = true
    return Response.json({ data: [] })
  })
  try {
    await expect(listProviderModels({ presetId: "custom", apiKey: "secret-key" })).rejects.toMatchObject({
      data: { code: "invalid_base_url" },
    })
    expect(called).toBe(false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

function mockFetch(handler: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = Object.assign(handler, { preconnect: originalFetch.preconnect })
}
