import { defineNitroPlugin } from "nitropack/runtime"
import { getRouterRuntime } from "../runtime"

// Instantiate the shared runtime during server boot so launch settings apply before the first API request.
export default defineNitroPlugin(() => {
  getRouterRuntime()
})
