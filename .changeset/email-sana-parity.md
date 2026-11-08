---
"@tatara/email": minor
"@tatara/notifications": minor
"@tatara/cli": patch
---

`@tatara/email`: `send` resolves to `{ id }` (the provider message id) and takes `cc`, `bcc`, `headers`, `attachments`, `priority`, and Mailgun `variables` and `tags`; `text` is optional when there is `html`. New: a durable queue over an app-implemented `EmailQueueStore` (`createEmailQueue`: `enqueue`, `hold`/`release`/`drop`/`discard`, `cancel`, `status`, `process` with retries and backoff, send log; `definitionRenderer` for `defineEmail` templates), a per-org suppression list over a `SuppressionStore` keyed by `emailHash` (`createSuppressionList`), signed unsubscribe tokens with RFC 8058 headers and page helpers (`createUnsubscribeTokens`, `unsubscribeHeaders`, `createUnsubscribePage`), the Mailgun webhook (`createMailgunWebhook`, `verifyMailgunSignature`), a branded RTL-aware layout and blocks (`wrapEmailContent`, `createEmailButton`, ...), `substitutePlaceholders`, `escapeHtml`, `hashVariables`, `createLanguageResolver`, and memory stores. `@tatara/notifications`: `PushContent` takes `imageUrl` and a web-push `link`, sent by `fcmPush`. `@tatara/cli`: the email template's test expects the `{ id }` result.
