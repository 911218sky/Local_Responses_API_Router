import { test } from "bun:test"
import assert from "node:assert"
import { normalizeProvider } from "../config/data-store"
import { rewriteModelObject } from "../router/proxy-service"

test("provider model mappings use the first exact or pattern match in configured order", () => {
  const provider = normalizeProvider({
    id: "image-route",
    slug: "image-route",
    name: "Image route",
    baseUrl: "https://example.test/v1",
    modelMappings: [
      { from: "gpt-5.6-terra", to: "gpt-image-2" },
      { from: "claude-haiku-4-5*", to: "gpt-5.6-terra", route: "messages" },
      { from: "claude-sonnet-?-20251001", to: "gpt-5.6-terra" },
      { from: "*", to: "nano-banana-2" },
    ],
  })
  const mappings = provider.modelMappings ?? []
  assert.deepStrictEqual(rewriteModelObject({ model: "gpt-5.6-terra", prompt: "x" }, mappings), {
    body: { model: "gpt-image-2", prompt: "x" },
    changed: true,
    from: "gpt-5.6-terra",
    to: "gpt-image-2",
  })
  assert.strictEqual(rewriteModelObject({ model: "claude-haiku-4-5-20251001" }, mappings).to, "gpt-5.6-terra")
  assert.strictEqual(
    (provider.modelMappings ?? []).find((mapping) => mapping.from === "claude-haiku-4-5*")?.route,
    "messages",
    "each mapping should preserve its configured upstream route",
  )
  assert.strictEqual(rewriteModelObject({ model: "claude-sonnet-5-20251001" }, mappings).to, "gpt-5.6-terra")
  assert.strictEqual(rewriteModelObject({ model: "any-image-model" }, mappings).to, "nano-banana-2")
  assert.strictEqual(
    rewriteModelObject(
      { model: "gpt-5.6-terra" },
      [
        { from: "*", to: "fallback-model" },
        { from: "gpt-5.6-terra", to: "specific-model" },
      ],
    ).to,
    "fallback-model",
  )
  assert.strictEqual(
    rewriteModelObject(
      { model: "gpt-5.6-terra" },
      [
        { from: "gpt-5.6-terra", to: "disabled-model", enabled: false },
        { from: "*", to: "fallback-model" },
      ],
    ).to,
    "fallback-model",
  )
})
