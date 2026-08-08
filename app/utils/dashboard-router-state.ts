export interface RouterPresentation {
  statusKey: "Router running" | "Router stopped"
  toggleKey: "Stop router" | "Start router"
  statusClass: "running" | "stopped"
}

export function routerPresentation(running: boolean): RouterPresentation {
  return running
    ? { statusKey: "Router running", toggleKey: "Stop router", statusClass: "running" }
    : { statusKey: "Router stopped", toggleKey: "Start router", statusClass: "stopped" }
}
