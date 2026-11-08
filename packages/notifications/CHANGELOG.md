# @tatara/notifications

## 0.4.0

### Minor Changes

- 1dda450: `@tatara/email`: `send` resolves to `{ id }` (the provider message id) and takes `cc`, `bcc`, `headers`, `attachments`, `priority`, and Mailgun `variables` and `tags`; `text` is optional when there is `html`. New: a durable queue over an app-implemented `EmailQueueStore` (`createEmailQueue`: `enqueue`, `hold`/`release`/`drop`/`discard`, `cancel`, `status`, `process` with retries and backoff, send log, and a lease per claimed job (`leaseMs`, default 5 minutes; `claimDue(now, limit, leaseUntil)` reclaims "processing" jobs whose `claimedUntil` passed, counting the crashed attempt); `definitionRenderer` for `defineEmail` templates), a per-org suppression list over a `SuppressionStore` keyed by `emailHash` (`createSuppressionList`), signed unsubscribe tokens with RFC 8058 headers and page helpers (`createUnsubscribeTokens`, `unsubscribeHeaders`, `createUnsubscribePage`), the Mailgun webhook (`createMailgunWebhook`, `verifyMailgunSignature`), a branded RTL-aware layout and blocks (`wrapEmailContent`, `createEmailButton`, ...), `substitutePlaceholders`, `escapeHtml`, `hashVariables`, `createLanguageResolver`, and memory stores. `@tatara/notifications`: `PushContent` takes `imageUrl` and a web-push `link`, sent by `fcmPush`. `@tatara/cli`: the email template's test expects the `{ id }` result.

### Patch Changes

- 1dda450: The email sender may return a value (e.g. `@tatara/email`'s `{ id }`); it is ignored.

## 0.3.0

### Minor Changes

- c0671ca: `@tatara/notifications`: in-app notifications can be stored as `titleKey`/`bodyKey`/`params` and translated when read, in the reader's language (`localizeNotification`, `translate` option); text notifications are unchanged. Channels can be `delivery: { email: "at-least-once" }` (pending, sent, marked sent; resent after a crash), at-most-once stays the default, and every sender gets a stable `{ idempotencyKey }`. `InAppContent` is now text or keys, so `title` may be undefined in code that reads it. Generated apps get `title_key`, `body_key`, `params` and `delivered_*` columns and `services/translate.ts`; existing apps need those columns (and a migration) only to use keys or at-least-once.

## 0.2.0

### Minor Changes

- 0d778b3: `authz.grantSystemRole(orgId, userId, key)`; generated apps with organizations make an org's creator its `admin` in their own `auth.ts` (and `authzOrganizationHooks` takes `creatorRole`). The notifier takes `allow({ userId, notification, channel, data })`, so the app decides who gets which channel. `sanitizeHtml` (`@tatara/core/html`, with `sanitize-html` installed). `tatara add <add-on…>` adds add-ons to an existing app. Observability registers in-thread ESM hooks (`module.registerHooks`) where Node has them, so Node 26 prints no deprecation; `@tatara/observability/hooks`.

### Patch Changes

- Updated dependencies [0d778b3]
  - @tatara/core@0.1.3

## 0.1.0

### Minor Changes

- 6bcea69: `@tatara/notifications`: `notify({ orgId, to, notification, data })` for in-app, email, SMS and push. Recipients are a user, users, a role or a permission; delivery goes through jobs (fan-out, then one delivery per user), each channel once per recipient, deduped by `idempotencyKey`. `defineNotification` templates in `notifications/*.ts`, Drizzle and Prisma stores, Twilio and FCM senders (console fallbacks). `@tatara/email`: a Mailgun driver and `defineEmail` templates. New `notifications` add-on (brings jobs and the cache): the inbox routes, push tokens, `SMS_DRIVER`/`PUSH_DRIVER`. Codemod 0.11.0 `email-v2`.

### Patch Changes

- Updated dependencies [315003d]
  - @tatara/core@0.1.2
