import { defineEventHandler } from "h3"
import { getRouterRuntime } from "../runtime"

export default defineEventHandler(() => {
  const status = getRouterRuntime().router.status()
  return {
    status: "ok",
    router: status.running ? "running" : "stopped",
    activeRequests: status.activeRequests.length,
  }
})
