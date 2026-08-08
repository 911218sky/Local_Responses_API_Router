import * as fs from "node:fs"
import * as path from "node:path"
import { isJsonArray, isJsonObject } from "../core/types"
import { RouterDatabase } from "./sqlite-store"

// This one-shot command preserves data written by versions that used JSON files.
const dataDirectory = process.env.CODEX_ROUTER_DATA_DIR || "/data"
const database = new RouterDatabase(dataDirectory)
const configPath = path.join(dataDirectory, "config.json")
const config = readJson(configPath)
const logs = readArray(path.join(dataDirectory, "request-logs.json"))
const contexts = readArray(path.join(dataDirectory, "response-contexts.json"))
const importedConfig = isJsonObject(config)
let importedLogs = 0
let importedContexts = 0

if (importedConfig) database.saveSettingIfNewer("config", config, fs.statSync(configPath).mtime.toISOString())

for (const value of logs) {
  if (
    !isJsonObject(value) ||
    typeof value.id !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.status !== "string"
  )
    continue
  database.saveLog(value.id, value.createdAt, typeof value.sessionId === "string" ? value.sessionId : null, value)
  importedLogs += 1
}

for (const value of contexts) {
  if (
    !isJsonObject(value) ||
    typeof value.responseId !== "string" ||
    typeof value.updatedAt !== "string" ||
    !isJsonArray(value.requestInput) ||
    !isJsonArray(value.responseOutput)
  )
    continue
  database.saveContext(
    value.responseId,
    value.updatedAt,
    typeof value.sessionId === "string" ? value.sessionId : null,
    typeof value.logId === "string" ? value.logId : null,
    value,
  )
  importedContexts += 1
}

database.trimLogs(200)
database.trimContexts(500)
console.log(
  `Legacy sync completed: config ${importedConfig ? "updated" : "unchanged"}, ${importedLogs} logs, ${importedContexts} contexts.`,
)

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
  } catch {
    return undefined
  }
}

function readArray(filePath: string): unknown[] {
  const value = readJson(filePath)
  return Array.isArray(value) ? value : []
}
