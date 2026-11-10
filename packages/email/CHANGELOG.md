# @tatara/email

## 0.4.1

### Patch Changes

- Updated dependencies [1882c35]
  - @tatara/core@0.2.0

## 0.4.0

### Minor Changes

- 1dda450: `@tatara/email`: `send` resolves to `{ id }` (the provider message id) and takes `cc`, `bcc`, `headers`, `attachments`, `priority`, and Mailgun `variables` and `tags`; `text` is optional when there is `html`. New: a durable queue over an app-implemented `EmailQueueStore` (`createEmailQueue`: `enqueue`, `hold`/`release`/`drop`/`discard`, `cancel`, `status`, `process` with retries and backoff, send log, and a lease per claimed job (`leaseMs`, default 5 minutes; `claimDue(now, limit, leaseUntil)` reclaims "processing" jobs whose `claimedUntil` passed, counting the crashed attempt); `definitionRenderer` for `defineEmail` templates), a per-org suppression list over a `SuppressionStore` keyed by `emailHash` (`createSuppressionList`), signed unsubscribe tokens with RFC 8058 headers and page helpers (`createUnsubscribeTokens`, `unsubscribeHeaders`, `createUnsubscribePage`), the Mailgun webhook (`createMailgunWebhook`, `verifyMailgunSignature`), a branded RTL-aware layout and blocks (`wrapEmailContent`, `createEmailButton`, ...), `substitutePlaceholders`, `escapeHtml`, `hashVariables`, `createLanguageResolver`, and memory stores. `@tatara/notifications`: `PushContent` takes `imageUrl` and a web-push `link`, sent by `fcmPush`. `@tatara/cli`: the email template's test expects the `{ id }` result.

## 0.3.0

### Minor Changes

- 6bcea69: `@tatara/notifications`: `notify({ orgId, to, notification, data })` for in-app, email, SMS and push. Recipients are a user, users, a role or a permission; delivery goes through jobs (fan-out, then one delivery per user), each channel once per recipient, deduped by `idempotencyKey`. `defineNotification` templates in `notifications/*.ts`, Drizzle and Prisma stores, Twilio and FCM senders (console fallbacks). `@tatara/email`: a Mailgun driver and `defineEmail` templates. New `notifications` add-on (brings jobs and the cache): the inbox routes, push tokens, `SMS_DRIVER`/`PUSH_DRIVER`. Codemod 0.11.0 `email-v2`.

### Patch Changes

- Updated dependencies [315003d]
  - @tatara/core@0.1.2

## 0.2.0

### Minor Changes

- fd669b1: Generated apps are smaller:
  - tatara's own wiring tests no longer go into apps; the e2e matrix runs them.
  - `@tatara/authz` ships the Prisma and Drizzle stores (`prismaAuthzStore(db)`, `drizzleAuthzStore(db, tables)`).
  - The db, authz, email, storage and jobs commands and seeds come from their packages. Packages declare them in a `"tatara"` field, and `tatara sync` wires them into `src/generated`. An app's own command with the same name wins.
  
  `tatara upgrade` now bumps every `@tatara/*` dependency to this CLI's version and installs before syncing. The 0.9.0 codemods remove the copies that are no longer needed.
