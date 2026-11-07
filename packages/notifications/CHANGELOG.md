# @tatara/notifications

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
