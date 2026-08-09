import type { H3Event } from "h3"
import {
  createError,
  defineEventHandler,
  getRequestHeader,
  getRequestHeaders,
  readBody,
  sendNoContent,
  setResponseHeaders,
} from "h3"
import { objectFromUnknown } from "../core/types"
import { isAuthorizedBasicHeader } from "../dashboard/auth"
import { listSessions, matchesSessionKey } from "../dashboard/sessions"
import { getRouterRuntime } from "../runtime"

export default defineEventHandler(async (event) => {
  const runtime = getRouterRuntime()
  const requestPath = event.path.replace(/^\/api\/?/, "").replace(/\/$/, "")
  const headers = getRequestHeaders(event)
  if (!isAuthorizedBasicHeader(getRequestHeader(event, "authorization"), runtime.state.dashboardAuth)) {
    setResponseHeaders(event, { "www-authenticate": 'Basic realm="LLM Router Dashboard"' })
    throw createError({ statusCode: 401, statusMessage: "Authentication required." })
  }
  if (!isReadOnly(event.method) && !isSameOriginMutation(headers))
    throw createError({ statusCode: 403, statusMessage: "Dashboard request origin is not allowed." })

  if (event.method === "GET" && requestPath === "state") return runtime.publicState()
  if (event.method === "GET" && requestPath === "logs")
    return { enabled: runtime.state.recordLogs, logs: runtime.logs.list() }
  if (event.method === "DELETE" && requestPath === "logs") {
    runtime.clearTrafficData()
    return sendNoContent(event)
  }
  if (requestPath.startsWith("logs/")) return logRoute(event, runtime, requestPath.slice("logs/".length))
  if (event.method === "GET" && requestPath === "contexts")
    return { enabled: runtime.state.persistResponseContexts, sessions: runtime.contexts.listSessions() }
  if (event.method === "POST" && requestPath === "contexts/import")
    return runtime.importContext(objectFromUnknown(await readBody(event)))
  if (requestPath.startsWith("contexts/")) return contextRoute(event, runtime, requestPath.slice("contexts/".length))
  if (event.method === "GET" && requestPath.startsWith("sessions/"))
    return sessionRoute(runtime, requestPath.slice("sessions/".length))
  if (event.method === "POST" && requestPath === "providers") return runtime.addProvider(await readBody(event))
  if (requestPath.startsWith("providers/")) return providerRoute(event, runtime, requestPath.slice("providers/".length))
  if (event.method === "PUT" && requestPath === "config")
    return runtime.updateConfig(objectFromUnknown(await readBody(event)))
  if (event.method === "POST" && requestPath === "router/start") return runtime.router.start()
  if (event.method === "POST" && requestPath === "router/stop") return runtime.router.stop()
  if (event.method === "POST" && requestPath.startsWith("active-requests/") && requestPath.endsWith("/cancel"))
    return cancelRoute(runtime, requestPath)
  if (event.method === "POST" && requestPath === "shutdown") {
    setTimeout(() => runtime.router.stop(), 100)
    return { shuttingDown: true }
  }
  if (event.method === "GET" && requestPath === "events") return streamEvents(event, runtime)
  throw createError({ statusCode: 404, statusMessage: "API endpoint not found." })
})

async function logRoute(event: H3Event, runtime: ReturnType<typeof getRouterRuntime>, id: string): Promise<unknown> {
  const decoded = decodeURIComponent(id)
  if (event.method === "GET") {
    const log = runtime.logs.get(decoded)
    if (!log) throw createError({ statusCode: 404, statusMessage: "Log entry not found." })
    return log
  }
  if (event.method === "DELETE") {
    const removed = runtime.logs.get(decoded)
    if (!removed) throw createError({ statusCode: 404, statusMessage: "Log entry not found." })
    runtime.logs.database.runTransaction(() => {
      runtime.logs.remove(decoded)
      runtime.contexts.removeByLogIds([removed.id])
    })
    return sendNoContent(event)
  }
  throw createError({ statusCode: 405, statusMessage: "Method not allowed." })
}

async function contextRoute(
  event: H3Event,
  runtime: ReturnType<typeof getRouterRuntime>,
  id: string,
): Promise<unknown> {
  const decoded = decodeURIComponent(id)
  if (event.method === "GET") {
    const context = runtime.contexts.get(decoded)
    if (!context) throw createError({ statusCode: 404, statusMessage: "Response context not found." })
    return { ...context, history: runtime.contexts.getHistory(decoded) || [] }
  }
  if (
    event.method === "DELETE" &&
    new URL(event.node.req.url || "", "http://localhost").searchParams.get("scope") === "session"
  ) {
    let removedCount = 0
    runtime.contexts.database.runTransaction(() => {
      removedCount = runtime.contexts.removeSession(decoded).length
      runtime.logs.removeSession(decoded)
    })
    return { removed: removedCount }
  }
  if (event.method === "DELETE") {
    const removed = runtime.contexts.get(decoded)
    if (!removed) throw createError({ statusCode: 404, statusMessage: "Response context not found." })
    runtime.contexts.database.runTransaction(() => {
      runtime.contexts.remove(decoded)
      runtime.logs.detachResponseContext(removed.responseId)
    })
    return sendNoContent(event)
  }
  throw createError({ statusCode: 405, statusMessage: "Method not allowed." })
}

async function providerRoute(
  event: H3Event,
  runtime: ReturnType<typeof getRouterRuntime>,
  id: string,
): Promise<unknown> {
  const decoded = decodeURIComponent(id)
  if (event.method === "PUT") return runtime.updateProvider(decoded, await awaitBody(event))
  if (event.method === "DELETE") {
    runtime.removeProvider(decoded)
    return Promise.resolve(sendNoContent(event))
  }
  throw createError({ statusCode: 405, statusMessage: "Method not allowed." })
}

async function awaitBody(event: H3Event): Promise<Record<string, unknown>> {
  return objectFromUnknown(await readBody(event))
}

function sessionRoute(runtime: ReturnType<typeof getRouterRuntime>, id: string): object {
  const decoded = decodeURIComponent(id)
  const session = listSessions(runtime.logs, runtime.contexts).find((item) =>
    matchesSessionKey(item.sessionId, decoded),
  )
  if (!session) throw createError({ statusCode: 404, statusMessage: "Session not found." })
  return {
    ...session,
    logs: runtime.logs
      .list()
      .filter((log) => matchesSessionKey(log.sessionId, decoded))
      .map((log) => runtime.logs.get(log.id))
      .filter((log) => log !== null),
    contexts: runtime.contexts.listBySession(session.sessionId),
    replay: runtime.contexts.getSessionReplay(session.sessionId),
  }
}

function cancelRoute(runtime: ReturnType<typeof getRouterRuntime>, path: string): object {
  const id = decodeURIComponent(path.slice("active-requests/".length, -"/cancel".length))
  const result = runtime.router.cancelActiveRequest(id)
  if (!result.found) throw createError({ statusCode: 404, statusMessage: "Active request not found." })
  return result
}

function streamEvents(event: H3Event, runtime: ReturnType<typeof getRouterRuntime>): Promise<void> {
  const response = event.node.res
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  response.write(`data: ${JSON.stringify({ type: "ready" })}\n\n`)
  const send = (source: string, value: unknown): void => {
    if (!response.writableEnded) response.write(`data: ${JSON.stringify({ source, ...objectFromUnknown(value) })}\n\n`)
  }
  const logListener = (value: unknown): void => send("logs", value)
  const contextListener = (value: unknown): void => send("contexts", value)
  const routerListener = (value: unknown): void => send("router", value)
  runtime.logs.on("changed", logListener)
  runtime.contexts.on("changed", contextListener)
  runtime.router.on("changed", routerListener)
  event.node.req.on("close", () => {
    runtime.logs.off("changed", logListener)
    runtime.contexts.off("changed", contextListener)
    runtime.router.off("changed", routerListener)
  })
  return new Promise(() => undefined)
}

function isReadOnly(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS"
}
function isSameOriginMutation(headers: Record<string, string | undefined>): boolean {
  const source = headers.origin || headers.referer
  if (!source) return true
  const host = headers.host
  if (!host) return false
  try {
    return new URL(source).host === host
  } catch {
    return false
  }
}
