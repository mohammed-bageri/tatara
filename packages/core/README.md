# @tatara/core

Part of [tatara](https://github.com/mohammed-bageri/tatara). Commands, lifecycle, readiness,
logger options, and the small helpers every app needs.

## Crypto (`@tatara/core`)

- `randomCode(length, alphabet?)`, `numericCode(length?)`, `randomToken(bytes?)`, `hashToken`,
  `safeEqual`: codes and tokens without modulo bias, compared in constant time.
- `createEncryption(keys, options?)`: AES-256-GCM for secrets at rest. `keys` is
  `"id:base64key,…"` (32-byte keys); `active` picks the sealing key (default the first), so add a
  key and make it active to rotate, keep old ones to read.
  - `format: "enc1"` (default): `enc1.<id>.<iv>.<body>`, the key id authenticated.
  - `format: "colon"`: `k<id>:<iv>:<body>` in base64, readable by and from WebCrypto AES-GCM code;
    `legacyKey` reads unlabelled `<iv>:<body>` values (and seals with them while the ring is empty).
- `isSealed(value, format?)`: whether a stored value is already sealed (for backfills).
- `parseKeyRing(keys, { idPattern })` and `validateKeyRing(keys, active, { idPattern, keysName,
  activeName })`: the ring as a map, or every problem with it for env validation at boot; key
  material never appears in a message.

```ts
const secrets = createEncryption(env.ENCRYPTION_KEYS ?? "", {
	format: "colon",
	active: env.ENCRYPTION_ACTIVE_KEY,
	legacyKey: env.ENCRYPTION_KEY,
});
```

## Text (`@tatara/core`, `@tatara/core/html`)

- `cleanText(input, { multiline })`, zod `text({ max })`: NFC, no control or invisible characters,
  whitespace collapsed.
- `safeUrl(input, { protocols, defaultProtocol })`, zod `url(options)`: http(s) links only (or
  `protocols`), no credentials; `defaultProtocol: "https:"` turns `example.com` into a link.
- `@tatara/core/html` (needs `sanitize-html`): `sanitizeHtml(input, "text" | "email" | options)`
  keeps formatting only; options add `tags`, `attributes` (by tag, `"*"` for all), `styles`,
  `schemes` and `imageSchemes` to a profile. `stripHtml(input)` is the plain text of a fragment
  (escape it when you render it).

## Time (`@tatara/core/time`)

Calendar maths in an IANA zone (an organisation's, not the server's), with `Intl` only:
`civilMonthIn`, `civilDateIn`, `civilDayString`, `civilTimeIn`, `monthStartInZone`,
`dayStartInZone`, `zonedTimeToInstant` (DST gaps shift forward, overlaps take the earlier instant),
`zonedTimeCandidates` and `isValidTimeZone`.

## CSV (`@tatara/core/csv`)

`toCsv(header, rows, { bom, eol, delimiter })` and `escapeCsvCell(value, delimiter?)`. By default a
UTF-8 BOM and CRLF, so Excel reads non-Latin text.

## Async (`@tatara/core`)

`mapWithConcurrency(items, limit, fn)`: at most `limit` calls in flight, results in input order.
