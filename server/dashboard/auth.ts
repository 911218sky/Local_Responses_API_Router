import * as crypto from "node:crypto"
import type * as http from "node:http"
import type { DashboardAuth } from "../core/types"

export function isAllowedDashboardMutation(headers: http.IncomingHttpHeaders): boolean {
  const source = headers.origin || headers.referer
  if (!source) return true
  const requestHost = headerString(headers.host).trim()
  if (!requestHost) return false
  try {
    return new URL(source).host === requestHost
  } catch {
    return false
  }
}

export function authenticateDashboardRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  auth: DashboardAuth,
): boolean {
  if (!auth.enabled) return true
  return isAuthorizedBasicHeader(req.headers.authorization, auth) ? true : requestDashboardCredentials(res)
}

export function isAuthorizedBasicHeader(value: string | undefined, auth: DashboardAuth): boolean {
  if (!auth.enabled) return true
  const encoded = value?.match(/^Basic\s+(.+)$/i)?.[1]
  if (!encoded) return false
  const [username, password] = Buffer.from(encoded, "base64").toString("utf8").split(":")
  return username === auth.username && verifyPassword(password, auth.passwordHash)
}

export function updateDashboardAuth(
  current: DashboardAuth,
  enabled: unknown,
  username: unknown,
  password: unknown,
): DashboardAuth {
  const nextUsername = stringValue(username || current.username).trim()
  if (enabled === false) return { ...current, enabled: false, username: nextUsername }
  const nextPassword = stringValue(password)
  if (!nextPassword) {
    if (enabled === true && (!nextUsername || !current.passwordHash)) {
      throw new Error("Dashboard username and password are required when enabling authentication.")
    }
    return { ...current, enabled: enabled === true ? true : current.enabled, username: nextUsername }
  }
  if (!nextUsername) throw new Error("Dashboard username is required when setting a password.")
  return { enabled: true, username: nextUsername, passwordHash: hashPassword(nextPassword) }
}

function requestDashboardCredentials(res: http.ServerResponse): false {
  res.writeHead(401, {
    "www-authenticate": 'Basic realm="LLM Router Dashboard"',
    "content-type": "text/plain; charset=utf-8",
  })
  res.end("Authentication required.")
  return false
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("base64url")
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString("base64url")}`
}

function verifyPassword(password: string | undefined, storedHash: string): boolean {
  const [salt, expected] = storedHash.split(":")
  if (!salt || !expected) return false
  const actual = crypto.scryptSync(password || "", salt, 64)
  const expectedBuffer = Buffer.from(expected, "base64url")
  return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer)
}

function headerString(value: string | readonly string[] | undefined): string {
  return typeof value === "string" ? value : value?.[0] || ""
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : ""
}
