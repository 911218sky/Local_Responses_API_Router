import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import * as path from "node:path"

test("Given the public router proxy, When loading its Nginx configuration, Then large Responses requests are accepted", async () => {
  const configPath = path.join(import.meta.dir, "../../deploy/nginx/llm-router.conf")
  const config = await readFile(configPath, "utf8")

  expect(config).toContain("client_max_body_size 50m;")
})
