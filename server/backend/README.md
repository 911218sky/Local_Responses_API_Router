# Backend

The backend is a Bun-compatible Nitro runtime with explicit ownership boundaries.

- `server/runtime.ts` owns the RouterRuntime singleton and lifecycle reconciliation.
- `server/api/[...path].ts` owns Dashboard API authentication, mutations, and SSE wiring.
- `server/routes/healthz.get.ts` owns the Dashboard health endpoint.
- `dashboard/` contains Dashboard authentication, serialization, providers, and sessions.
- `router/` contains upstream routing, request transformation, retries, SSE forwarding, and active-request tracking.
- `storage/` contains SQLite persistence and request/context stores.
- `config/` loads, normalizes, and persists runtime configuration.
- `core/` contains shared strict types and JSON guards.

The runtime image is built with Bun and Nuxt, then runs only `.output/server/index.mjs`.
The Vue source lives in `app/`; generated `.nuxt/` and `.output/` directories are ignored.
