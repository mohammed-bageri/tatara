# @tatara/http

## 0.2.0

### Minor Changes

- 279dda4: `@tatara/http`: `handleErrors` options `translate` (code → localised message, with `codeTranslator(keys, t)`), `mapError` (app mappers that turn SDK / database errors into AppErrors), `codes` (rename codes in responses), `validationStatus` (400 or 422), `exposeErrors`, `redact` and `logger`. `createPagination({ sizeKey, navigation, emptyTotalPages, maxSize })` for the app's own pagination query/meta/schema/response, `success(data, message)`, `errorBody`, `contentDisposition`, `cursorPage(…, { extended: true })` with `extendedCursorMetaSchema`, `createValidationHook({ message: "first-issue", status, detail })` and `validationError`, `rejectCrossSite({ trusted, skip, onRefused })`, `ServiceUnavailableError`, `ValidationError`'s optional status, `uuidSchema` / `isUuid` / `uuidParams` / `idParamSchema`. Behaviour changes: a ZodError thrown from a handler is now a 400 VALIDATION_ERROR (it was a 500), the handler's own NOT_FOUND / INTERNAL_ERROR codes go through `codes`, and an empty error code is left out of the response.

## 0.1.5

### Patch Changes

- c0671ca: Cache OpenAPI document after first request, eliminating per-request rebuild cost

## 0.1.4

### Patch Changes

- 2173039: CORS belongs to the app: generated apps call Hono's `cors()` in `src/apps/http.ts`, with `corsOrigin` for exact origins and `*.` patterns, so the allowed headers and origins are theirs to change. `createApp`'s `cors` option is optional and deprecated (existing apps keep working), and the `allowOrigin` option from 0.1.3 is gone: an origin kept in the database is now just a check inside the app's `origin` function.

## 0.1.3

### Patch Changes

- 61d535a: `createApp({ cors: { allowOrigin } })`: a check for origins not in `origins`, for ones kept in the database (a game's web build address).

## 0.1.2

### Patch Changes

- 6170cca: `@tatara/http`: `rateLimit` (fixed window over any counter, 429 RATE_LIMITED with Retry-After, fails open), `clientIp`/`withClientIp` (trusted proxy hops), cursor pagination (`cursorQuerySchema`, `cursorPage`, `encodeCursor`/`decodeCursor`), CORS origin patterns (`https://*.example.com`), per-path request timeouts (504 REQUEST_TIMEOUT), and `startServer({ onServer })`. Generated apps time out requests after `REQUEST_TIMEOUT_MS`, give better-auth the caller's real address (`TRUSTED_PROXY_HOPS`), and with the cache add-on get `limitRequests`. New `tatara contracts` writes each app's OpenAPI document and TypeScript types for openapi-fetch clients (`--check` for CI). Codemod 0.11.0 `http-limits`.
- Updated dependencies [315003d]
  - @tatara/core@0.1.2

## 0.1.1

### Patch Changes

- b9ff8c7: `tatara eject <package> [--with-dependents]` copies a package's source into `src/ejected/<name>` and points the app's imports at it. After that, `tatara upgrade`, `sync` and the generators use the app's copy. Library packages now ship their `src` (without tests), so they can be ejected.
- Updated dependencies [b9ff8c7]
  - @tatara/core@0.1.1
