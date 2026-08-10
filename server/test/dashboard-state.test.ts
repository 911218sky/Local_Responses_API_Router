import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import * as path from "node:path"

test("Given a filled dashboard section, When another section is selected, Then its component stays mounted for the draft to persist", async () => {
  const source = await readFile(path.join(import.meta.dir, "../../app/app.vue"), "utf8")

  expect(source).toContain("<ProvidersView v-show=\"section === 'providers'\"")
  expect(source).toContain("<ProviderTestView v-show=\"section === 'test'\"")
  expect(source).toContain("<SettingsView v-show=\"section === 'settings'\"")
})
