export interface RouterLocation {
  readonly protocol: string
  readonly hostname: string
  readonly port: string
}

export function routerOrigin(current: RouterLocation, routerPort?: number): string {
  const localHost = current.hostname === "localhost" || current.hostname === "127.0.0.1" || current.hostname === "::1"
  const port = localHost ? routerPort : current.port ? Number(current.port) : undefined
  const defaultPort = (current.protocol === "http:" && port === 80) || (current.protocol === "https:" && port === 443)
  const host = current.hostname.includes(":") ? `[${current.hostname}]` : current.hostname
  const authority = port && !defaultPort ? `${host}:${port}` : host
  return `${current.protocol}//${authority}`
}

export function providerRouterUrl(
  current: RouterLocation,
  routerPort: number | undefined,
  providerSlug: string,
): string {
  return `${routerOrigin(current, routerPort)}/${encodeURIComponent(providerSlug)}/v1`
}

export function providerRouterRouteFormat(current: RouterLocation, routerPort: number | undefined): string {
  return `${routerOrigin(current, routerPort)}/{provider}/v1/responses`
}

export function publicRouterUrl(value: string, current: RouterLocation, routerPort: number | undefined): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return value
  }
  if (!isLocalHost(parsed.hostname)) return value
  const expectedPort = routerPort ?? 38128
  if (parsed.port && Number(parsed.port) !== expectedPort) return value
  return `${routerOrigin(current, routerPort)}${parsed.pathname}${parsed.search}${parsed.hash}`
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
}
