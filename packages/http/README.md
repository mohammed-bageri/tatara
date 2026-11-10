# @tatara/http

Part of [tatara](https://github.com/mohammed-bageri/tatara). Plain Hono / OpenAPIHono setup,
errors, the response envelope, pagination, OpenAPI docs and route mounting.

## Errors

Throw an `AppError` (`ValidationError`, `BusinessRuleError`, `UnauthorizedError`,
`ForbiddenError`, `NotFoundError`, `ConflictError`, `TooManyRequestsError`,
`RequestTimeoutError`, `ServiceUnavailableError`); `handleErrors` answers every error with
`{ success: false, error, code, details? }`.

```ts
handleErrors(app, {
	// localised messages for translatable errors and the handler's own (NOT_FOUND, INTERNAL_ERROR)
	translate: codeTranslator(ERROR_CODE_I18N, (key, c) => i18n.translator(c.get("language"))(key)),
	// SDK and database errors the app knows how to answer, tried first
	mapError: [
		(err) => (isUniqueViolation(err) ? new ConflictError() : undefined),
		(err) => (err instanceof AIError ? new AppError(err.statusCode, err.code, err.message) : undefined),
	],
	codes: { RATE_LIMITED: "RATE_LIMIT_EXCEEDED" }, // renamed in responses
	validationStatus: 422, // ValidationErrors without their own status, and thrown ZodErrors
	exposeErrors: env.NODE_ENV !== "production", // message, name and stack of unhandled errors
	redact: redactDbQueryErrors, // before logging or exposing an unhandled error
	logger, // when the request has no c.var.logger
});
```

`message: (err, c) => string` still decides every AppError's message when given. A thrown
ZodError is answered as a ValidationError.

## Responses and pagination

- `success(data, message?)`, `paginated(data, page, pageSize, total)`, `errorBody(code, message, details?)`.
- `createPagination({ sizeKey: "limit", navigation: true, emptyTotalPages: 0 })` gives
  `querySchema`, `metaSchema`, `schema(item)`, `paginated(data, { page, limit, total }, { meta, message })`,
  `meta` and `offset` in the app's shape (`{ page, limit, total, totalPages, hasNext, hasPrev }`).
  `createPagination()` is the default `page` / `pageSize` shape.
- `cursorPage(rows, limit, positionOf, { extended: true })` adds `limit` and `hasNext` to the meta.
- `decodeCursor(schema, cursor)` answers 400 INVALID_CURSOR for a bad cursor; `tryDecodeCursor` gives
  null instead, for lists that start over from the first page.
- `contentDisposition(fileName, "attachment")` for any file name, Unicode included.

## Validation and middleware

- `createValidationHook({ message: "first-issue", status: 400, detail })` for `defaultHook`;
  `validationHook` is the default (generic message, `{ path, message, code }` details).
- `rejectCrossSite({ trusted: corsOrigin(origins), skip, onRefused })` refuses writes from untrusted
  browser origins (403 `CROSS_SITE_REQUEST_REFUSED`).
- `rateLimit`, `requestTimeout`, `clientIp` / `trustedClientIp`, `uuidParams("orgId", "id")`, `isUuid`.
