# @tatara/email

Part of [tatara](https://github.com/mohammed-bageri/tatara-cli).

Sending email: a transport, templates and a layout, a durable queue over the app's tables, a
per-organization suppression list, signed unsubscribe links and the Mailgun webhook. The app owns
the tables and implements two small store interfaces; `memoryEmailQueueStore()` and
`memorySuppressionStore()` are there for tests.

## Transport

`createMailer({ driver: "smtp" | "mailgun" | "console", from, logger, smtpUrl?, mailgun? })`.
`send(message)` resolves to `{ id }`, the provider's message id (null for the console driver).
A message has `to`, `subject`, `text` and/or `html`, and optionally `replyTo`, `cc`, `bcc`,
`headers`, `attachments`, `priority` (no click/open tracking, high-priority headers: for sign-in
links), and the Mailgun-only `variables` (`v:`, echoed on webhooks) and `tags` (`o:tag`).

## Templates and layout

`defineEmail({ name, schema, render })` in `src/modules/*/emails/*.ts`; `tatara sync` lists them.
`wrapEmailContent(innerHtml, { companyName, supportEmail, logoUrl?, primaryColor? }, { language,
unsubscribeUrl? })` is a table-based layout, right-to-left for Arabic, Persian, Hebrew and Urdu,
with `createEmailButton`, `createEmailButtonOutline`, `createDetailsCard`, `createDetailRow` and
`createStatusBadge` for the content. For templates people edit and store:
`substitutePlaceholders("Hi {{name}}", variables, { language, formatDate? })`, `escapeHtml`,
`missingVariables`.

## The queue

```ts
const queue = createEmailQueue({ store, mailer, render, suppressions, unsubscribe, logger });
await queue.enqueue({ orgId, templateKey, recipient, variables, idempotencyKey, language });
await queue.process(); // from a schedule, e.g. every minute
```

- `enqueue` inserts once per `idempotencyKey` (`{ status: "exists" }` after that). `scheduledFor`
  delays it; `entityType`/`entityId` file it under what it's about; `executor` is the caller's
  transaction.
- `hold` queues it unsent until `release(ids)`; `drop(ids)` cancels held emails, `discard`
  deletes them (by ids or entity), freeing their keys. `cancel({ ids } | { idempotencyKey } |
  { entityType, entityId })` stops pending and held ones. `status(idempotencyKey)`.
- `process({ limit })` claims due jobs, renders each with your `render(job, { unsubscribeUrl })`
  (layout included; `definitionRenderer(emails, { layout })` does it for `defineEmail`
  templates), sends it and logs it. A failure retries after 1m, 5m, 15m, 1h, 4h (`backoffMs`)
  up to `maxAttempts` (5), then the job fails and is logged. A suppressed recipient's job is
  cancelled. A second `process` in the same process while one runs is skipped.
- A claimed job is the worker's for `leaseMs` (5 minutes; longer than one send can take). If
  the worker dies mid-send, the job stays "processing" until the lease is over, then the next
  `process` claims it again, counting the attempt that crashed: never two sends within a lease,
  and a job that crashes every time fails after `maxAttempts`.
- Every send carries the job id as a provider variable (`jobIdVariable`, default
  `tatara_job_id`), so a webhook finds the job.

`EmailQueueStore`: `insert`, `claimDue(now, limit, leaseUntil)` (atomic, `FOR UPDATE SKIP
LOCKED`: due pending jobs, plus "processing" ones whose `claimedUntil` has passed, with
`attempts + 1`; sets `claimedUntil = leaseUntil`), `update`,
`updateWhere`, `deleteWhere`, `get`, `findByIdempotencyKey`, `log`, `findSent`.

## Suppressions and unsubscribe

`createSuppressionList(store)` gives `reason`, `reasons`, `suppress` (the first reason stays) and
`send(mailer, orgId, message)`, which skips a suppressed recipient. The store sees only
`emailHash(address)` (SHA-256 of the trimmed, lower-cased address), so the list outlives an
erased person: `SuppressionStore` is `find(orgId, hashes)` and `add({ orgId, hash, reason,
sourceJobId })`.

`createUnsubscribeTokens({ secret, info? })` signs a job id (`<id>.<HMAC>`, no address, no
expiry). Give the queue `unsubscribe: { tokens, urls(job, token) }` and jobs with
`unsubscribeLink: true` get the link (in the layout and the text part) and RFC 8058
`List-Unsubscribe` headers. `createUnsubscribePage({ tokens, store, suppressions })` serves the
page: `status(token)` and `unsubscribe(token)`, null for an invalid link.

## Mailgun webhook

```ts
const webhook = createMailgunWebhook({ signingKey, store, suppressions, replay: cache, logger });
const result = await webhook.handle(await c.req.json()); // answer with result.status
```

It verifies the signature (15-minute window), refuses a replayed token (`replay` is
`@tatara/cache` or anything with `add` and `del`), and records hard bounces, complaints and
unsubscribes for the job's org: 200, 406 for a bad or replayed signature, 404 without a key.

## Language

`createLanguageResolver([{ priority, resolve(orgId, address, ref) }], { fallback: "en" })`
asks each source in priority order for the recipient's language.
