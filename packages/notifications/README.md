# @tatara/notifications

Part of [tatara](https://github.com/mohammed-bageri/tatara-cli).

`notify({ orgId, to, notification, data })` stores an in-app notification and sends it by email,
SMS and push, through two jobs (`notifications.fanout`, then one `notifications.deliver` per user).
Recipients are a user, a list, or everyone in the org with a role or permission. Each channel goes
out once per recipient however often a job retries.

## Text or keys

`inApp` returns rendered text (`{ title, body }`, in the recipient's language at delivery) or keys
(`{ titleKey, bodyKey, params }`) stored as they are and translated when the inbox is read, in the
reader's language: `localizeNotification(row, language, translate)`. With `@tatara/i18n`,
`translate` is `(language, key, params, fallback) => t(language, key, fallback, params)`. Give
both and the text is the fallback for a missing translation. Keys need the `title_key`,
`body_key` and `params` columns; tables without them keep taking text notifications.

## Delivery modes

Per channel, in `createNotifier({ delivery: { email: "at-least-once" } })`:

- `at-most-once` (the default): the channel is taken before it's sent. Two deliveries of a job
  never both send it, but a crash between taking and sending loses that send.
- `at-least-once`: the channel is recorded pending, sent, then marked sent. A crash in between
  leaves it pending and the job's next delivery sends it again (a jobs driver that redelivers a
  job whose worker died, e.g. Postgres after `visibilityMs`; the inline driver can't). A slow worker and a redelivery can both send, so every sender gets
  `{ idempotencyKey }` (`<notification id>:<channel>:<user id>`, the same on every retry) to hand to
  a provider that dedupes on it. Needs the `delivered_*` columns (`claimPending`/`markSent` in the
  store).
