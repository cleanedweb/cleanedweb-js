# Changelog

All notable changes to this package are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package follows
[Semantic Versioning](https://semver.org/). Until 1.0.0, a minor release can change the API.

## [Unreleased]

## [0.2.0] - 2026-11-23

### Added

- `cleanedweb/ai-sdk`: Vercel AI SDK tools `findApi`, `getApi` and `runApi`, and `cleanedwebTools()`
  for all three. `findApi` ranks catalog APIs by topic words and wanted fields; `getApi` returns
  inputs, output fields and saved sample records; `runApi` runs an endpoint (default 20 records) and
  reports whether the result passes the acceptance checks. Works with AI SDK 5, 6 and 7; `ai` is an
  optional peer dependency, so the core SDK keeps zero runtime dependencies.

## [0.1.1] - 2026-11-21

### Changed

- Published from GitHub Actions through npm trusted publishing, with provenance. No code changes.
- README installs from npm.

## [0.1.0] - 2026-11-21

First release on npm.

### Added

- `CleanedWeb` client with `catalog`, `runs` and `sources`. Zero runtime dependencies; uses the global `fetch`.
- `catalog.list`, `iterate`, `get` (by `api_id` or slug), `contract`, `index` and `find` (client-side filter by site and fields). Anonymous: no API key is sent.
- `catalog.run` and `catalog.result`: required `Idempotency-Key` (generated and returned), `202` handling that reads `/result` with the same key after `Retry-After`, `wait: false`, `onProgress`, `AbortSignal`, major pinning with `version`.
- `runs.get`, `items` (async iterator over cursor pages, following a running run), `itemsPage`, `pages`, `result`, `abort` and `list`.
- `sources.run` and `sources.start` for private source APIs.
- Typed errors: `AuthenticationError`, `PermissionError`, `InsufficientCreditError`, `UsageBudgetExceededError`, `RateLimitError`, `VersionConflictError`, `IdempotencyConflictError`, `NotFoundError`, `ValidationError`, `ServerError`, `RunFailedError`, plus connection, timeout, abort and configuration errors. Errors carry the idempotency key and run id.
- Bounded automatic retries (same idempotency key) for lost connections, `429`, `502`, `503` and `504`; a failed run is never retried.
- `isAccepted` and `assertAccepted` for the documented result checks.
- ESM and CJS builds with types. Node 18 or later.
