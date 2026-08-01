---
name: new-slice
description: Scaffold a Gamarr feature slice (models/ports/repository/service) and its API route
disable-model-invocation: true
---

# Scaffolding a feature slice

Gamarr's five existing features all follow the same shape. Match it — the
consistency is what keeps handlers testable without Next.js and keeps Drizzle
confined to one file per slice.

## Naming

Templates in `templates/` use two placeholders:

- `__feature__` — directory name, lowercase kebab (`release-search`)
- `__Feature__` — PascalCase type prefix (`ReleaseSearch`)

## Feature layer — `src/features/<name>/`

Copy from `templates/`, drop the `.template` suffix, and substitute both
placeholders:

| Template | Destination | Contains |
| --- | --- | --- |
| `models.ts.template` | `src/features/<name>/models.ts` | Domain types only. No Drizzle types, no React, no I/O. |
| `ports.ts.template` | `src/features/<name>/ports.ts` | Interfaces for everything external this slice needs. |
| `repository.ts.template` | `src/features/<name>/repository.ts` | `Sqlite<Feature>Repository` — the only Drizzle caller. |
| `service.ts.template` | `src/features/<name>/service.ts` | Orchestration, depends on ports only. |
| `service.test.ts.template` | `src/features/<name>/service.test.ts` | Hand-rolled port fakes, no module mocking. |

## API layer — `src/app/api/<area>/`

| Template | Destination | Contains |
| --- | --- | --- |
| `api-route.ts.template` | `route.ts` | Thin shim. `runtime`/`dynamic` exports, delegates to the handler. |
| `api-dependencies.ts.template` | `dependencies.ts` | Composition root. `import "server-only"`, builds concrete instances. |
| `api-handlers.ts.template` | `handlers.ts` | Guard, validate, call service, `errorResponse`. Takes deps as a parameter. |

The `.template` suffix keeps these out of `pnpm lint` and `pnpm typecheck` —
they contain placeholder identifiers and are not meant to compile in place.

## Rules that make this work

**Handlers take dependencies as an argument** and declare a narrow structural
interface for the service rather than importing the concrete class. That is what
lets `handlers.test.ts` inject a plain object with no Next.js runtime.

**`dependencies.ts` is the only place** that calls `getDatabase()`, reads
`process.env`, or constructs an integration client. If a service imports a client
directly, the boundary is broken.

**Mutating routes must call `assertTrustedMutation(request, policy)`** before
anything else, with the policy built by `parseOriginPolicy` in
`dependencies.ts`. GET routes that only read may skip it.

**Throw `AppError`** (or `validationError` / `forbiddenError` from
`@/lib/errors`) and let `errorResponse` serialize. Never let an upstream error
message reach the response — indexer errors routinely carry API keys.

**Component tests need `/** @vitest-environment jsdom */`** as the first line;
the default environment is `node`.

## After scaffolding

```bash
pnpm typecheck && pnpm test
```

The templates deliberately leave repository methods throwing `not implemented`
so a half-wired slice fails loudly rather than silently returning empty data.
