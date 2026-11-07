---
"@tatara/notifications": minor
"@tatara/cli": minor
---

`@tatara/notifications`: in-app notifications can be stored as `titleKey`/`bodyKey`/`params` and translated when read, in the reader's language (`localizeNotification`, `translate` option); text notifications are unchanged. Channels can be `delivery: { email: "at-least-once" }` (pending, sent, marked sent; resent after a crash), at-most-once stays the default, and every sender gets a stable `{ idempotencyKey }`. `InAppContent` is now text or keys, so `title` may be undefined in code that reads it. Generated apps get `title_key`, `body_key`, `params` and `delivered_*` columns and `services/translate.ts`; existing apps need those columns (and a migration) only to use keys or at-least-once.
