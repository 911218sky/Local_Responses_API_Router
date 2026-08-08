export async function parseDashboardResponse(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined
  return response.json()
}
