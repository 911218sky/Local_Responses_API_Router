import type * as http from "node:http"
import type { JsonArray, JsonObject, ResponseContextMetadata } from "../core/types"
import { isJsonArray, isJsonObject } from "../core/types"
import type { RequestLogStore } from "../storage/request-log"
import type { ResponseContextStore } from "../storage/response-context"
import { parseSse } from "./http-utils"
import { recordResponseContext } from "./transformer"

export interface ResponseContextObserver {
  completeResponse(): {
    readonly response: JsonObject | undefined
    readonly usage: JsonObject | undefined
  }
}

export function createResponseContextObserver(
  upstream: http.IncomingMessage,
  logStore: RequestLogStore,
  logId: string,
  requestInput: JsonArray,
  contextStore: ResponseContextStore,
  contextMetadata: ResponseContextMetadata,
): ResponseContextObserver {
  let sseBuffer = ""
  let responseId: string | undefined
  let completedResponse: JsonObject | undefined
  const outputItems = new Map<number, JsonObject>()

  upstream.on("data", (chunk) => {
    sseBuffer += chunk.toString("utf8")
    while (true) {
      const match = sseBuffer.match(/\r?\n\r?\n/)
      if (!match) break
      const index = match.index
      if (index === undefined) break
      const block = sseBuffer.slice(0, index)
      sseBuffer = sseBuffer.slice(index + match[0].length)
      const event = parseSse(block)
      if (!event) continue
      const eventResponse = isJsonObject(event.response) ? event.response : null
      const eventResponseId = eventResponse?.id
      responseId =
        typeof eventResponseId === "string"
          ? eventResponseId
          : typeof event.response_id === "string"
            ? event.response_id
            : responseId
      if (eventResponse && isJsonArray(eventResponse.output)) {
        completedResponse = eventResponse
        outputItems.clear()
        eventResponse.output.forEach((item, index) => {
          if (isJsonObject(item)) outputItems.set(index, item)
        })
      } else if (
        (event.type === "response.output_item.added" || event.type === "response.output_item.done") &&
        isJsonObject(event.item) &&
        typeof event.output_index === "number"
      ) {
        outputItems.set(event.output_index, event.item)
      } else if (
        event.type === "response.function_call_arguments.delta" ||
        event.type === "response.function_call_arguments.done"
      ) {
        const call = typeof event.output_index === "number" ? outputItems.get(event.output_index) : undefined
        if (call?.type === "function_call") {
          call.arguments = event.type.endsWith(".done")
            ? typeof event.arguments === "string"
              ? event.arguments
              : ""
            : `${typeof call.arguments === "string" ? call.arguments : ""}${typeof event.delta === "string" ? event.delta : ""}`
          if (event.type.endsWith(".done")) call.status = "completed"
        }
      }
      if (responseId && outputItems.size) {
        const output = [...outputItems.entries()].sort(([left], [right]) => left - right).map(([, item]) => item)
        recordResponseContext(responseId, requestInput, output, contextStore, contextMetadata)
        if (event.type === "response.function_call_arguments.done" || event.type === "response.completed") {
          logStore.update(logId, {
            responseContext: {
              responseId,
              outputItemCount: output.length,
              persisted: Boolean(contextStore),
              updatedAt: new Date().toISOString(),
            },
          })
        }
      }
    }
  })
  return {
    completeResponse: (): { readonly response: JsonObject | undefined; readonly usage: JsonObject | undefined } => ({
      response: completedResponse,
      usage: completedResponse && isJsonObject(completedResponse.usage) ? completedResponse.usage : undefined,
    }),
  }
}
