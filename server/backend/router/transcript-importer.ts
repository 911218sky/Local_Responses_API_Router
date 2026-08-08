import * as fs from "node:fs"
import * as path from "node:path"
import {
  errorMessage,
  isJsonArray,
  isJsonObject,
  type JsonArray,
  type JsonObject,
  type ResponseContextMetadata,
} from "../core/types"
import type { ResponseContextStore } from "../storage/response-context"

interface TranscriptRow {
  readonly type: string
  readonly data: JsonObject
}

function importCopilotTranscript(
  filePath: string,
  responseId: string,
  contextStore: ResponseContextStore,
  metadata: ResponseContextMetadata = {},
): {
  readonly context: NonNullable<ReturnType<ResponseContextStore["save"]>>
  readonly transcriptSessionId: string
  readonly label: string
  readonly itemCount: number
} {
  if (!path.isAbsolute(filePath)) throw new Error("Transcript path must be absolute.")
  if (path.extname(filePath).toLowerCase() !== ".jsonl")
    throw new Error("Only Copilot .jsonl transcripts can be imported.")
  const rows = readJsonLines(filePath)
  const sessionStart = rows.find((row) => row.type === "session.start")
  const transcriptSessionId = stringValue(sessionStart?.data.sessionId) || path.basename(filePath, ".jsonl")
  const history = buildHistory(rows)
  if (!history.length) throw new Error("The selected transcript contains no importable messages or tool calls.")
  const firstUser = rows.find((row) => row.type === "user.message" && typeof row.data.content === "string")
  const label = metadata.label || truncate(stringValue(firstUser?.data.content) || path.basename(filePath), 80)
  const context = contextStore.save(responseId, history, [], {
    sessionId: transcriptSessionId,
    sourceInteractionId: `import:${transcriptSessionId}`,
    provider: metadata.provider || null,
    imported: true,
    label,
  })
  if (!context) throw new Error("Unable to save imported continuation context.")
  return { context, transcriptSessionId, label, itemCount: history.length }
}

function readJsonLines(filePath: string): TranscriptRow[] {
  let text: string
  try {
    text = fs.readFileSync(filePath, "utf8")
  } catch (error) {
    throw new Error(`Unable to read transcript: ${errorMessage(error)}`)
  }
  const rows: TranscriptRow[] = []
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (!isTranscriptRow(parsed)) throw new Error(`Transcript line ${index + 1} is not valid JSON.`)
      rows.push(parsed)
    } catch {
      throw new Error(`Transcript line ${index + 1} is not valid JSON.`)
    }
  }
  return rows
}

function buildHistory(rows: readonly TranscriptRow[]): JsonArray {
  const history: JsonArray = []
  for (const row of rows) {
    if (row.type === "user.message" && typeof row.data.content === "string" && row.data.content.trim()) {
      history.push(message("user", row.data.content))
      continue
    }
    if (row.type !== "assistant.message") continue
    if (typeof row.data.content === "string" && row.data.content.trim())
      history.push(message("assistant", row.data.content))
    const tools = isJsonArray(row.data.toolRequests) ? row.data.toolRequests : []
    for (const tool of tools) {
      if (!isJsonObject(tool) || !stringValue(tool.toolCallId) || !stringValue(tool.name)) continue
      history.push({
        type: "function_call",
        id: stringValue(tool.toolCallId),
        call_id: stringValue(tool.toolCallId),
        name: stringValue(tool.name),
        arguments: typeof tool.arguments === "string" ? tool.arguments : JSON.stringify(tool.arguments || {}),
        status: "completed",
      })
    }
  }
  return history
}

function message(role: "assistant" | "user", text: string): JsonObject {
  return { type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] }
}
function isTranscriptRow(value: unknown): value is TranscriptRow {
  return isJsonObject(value) && typeof value.type === "string" && isJsonObject(value.data)
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 3)}...` : value
}

export { buildHistory, importCopilotTranscript }
