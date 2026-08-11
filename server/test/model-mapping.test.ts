import { test } from "bun:test"
import assert from "node:assert"
import { normalizeProvider } from "../config/data-store"
import { rewriteModelObject } from "../router/proxy-service"

test("provider model mappings rewrite exact and wildcard models", () => {
  const provider = normalizeProvider({
    id: "image-route",
    slug: "image-route",
    name: "Image route",
    baseUrl: "https://example.test/v1",
    modelMappings: [
      { from: "gpt-5.6-terra", to: "gpt-image-2" },
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
  assert.strictEqual(rewriteModelObject({ model: "any-image-model" }, mappings).to, "nano-banana-2")
})
