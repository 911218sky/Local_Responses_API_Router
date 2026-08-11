import type { Provider, PublicProvider, PublicRouterConfig, RouterConfig } from "../core/types"

export function validateProvider(provider: Provider, others: readonly Provider[]): void {
  if (!provider.slug) throw new Error("Provider route identifier is required.")
  let baseUrl: URL
  try {
    baseUrl = new URL(provider.baseUrl)
  } catch {
    throw new Error("Provider upstream URL must be a valid http:// or https:// URL.")
  }
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:")
    throw new Error("Provider upstream URL must begin with http:// or https://.")
  if (baseUrl.username || baseUrl.password)
    throw new Error("Provider upstream URL must not contain embedded credentials.")
  if (others.some((item) => item.slug === provider.slug))
    throw new Error(
      "Provider route identifier must be unique. The same upstream URL can be used with a different route id.",
    )
}

export function publicConfig(source: RouterConfig): PublicRouterConfig {
  const { passwordHash: _passwordHash, ...dashboardAuth } = source.dashboardAuth
  return {
    ...source,
    dashboardAuth,
    providers: source.providers.map(publicProvider),
  }
}

export function publicProvider(provider: Provider): PublicProvider {
  return {
    id: provider.id,
    slug: provider.slug,
    name: provider.name,
    baseUrl: redactUrlCredentials(provider.baseUrl),
    enabled: provider.enabled,
    routeOnly: provider.routeOnly,
    modelMappings: provider.modelMappings ?? [],
  }
}

function redactUrlCredentials(value: string): string {
  try {
    const url = new URL(value)
    url.username = ""
    url.password = ""
    return url.toString().replace(/\/$/, "")
  } catch {
    return "[invalid upstream URL]"
  }
}
