import type * as http from "node:http"
import type { JsonArray, JsonObject, ResponseContextMetadata } from "../core/types"
import { isJsonArray, isJsonObject } from "../core/types"
import type { RequestLogStore } from "../storage/request-log"
import type { ResponseContextStore } from "../storage/response-context"
import { parseSse } from "./http-utils"
import { recordResponseContext } from "./transformer"

export interface ResponseContextObserver {
  completeResponse(
    response?: JsonObject,
    persist?: boolean,
  ): {
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
  let saved = false

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
    }
  })
  return {
    completeResponse: (
      response?: JsonObject,
      persist = true,
    ): { readonly response: JsonObject | undefined; readonly usage: JsonObject | undefined } => {
      const finalResponse = completedResponse || response
      const finalResponseId = typeof finalResponse?.id === "string" ? finalResponse.id : responseId
      const finalOutput =
        finalResponse && isJsonArray(finalResponse.output)
          ? finalResponse.output
          : [...outputItems.entries()].sort(([left], [right]) => left - right).map(([, item]) => item)
      if (persist && !saved && finalResponseId && finalOutput) {
        saved = true
        recordResponseContext(finalResponseId, requestInput, finalOutput, contextStore, contextMetadata)
        logStore.update(logId, {
          responseContext: {
            responseId: finalResponseId,
            outputItemCount: finalOutput.length,
            persisted: true,
            updatedAt: new Date().toISOString(),
          },
        })
      }
      return {
        response: finalResponse,
        usage: finalResponse && isJsonObject(finalResponse.usage) ? finalResponse.usage : undefined,
      }
    },
  }
}
