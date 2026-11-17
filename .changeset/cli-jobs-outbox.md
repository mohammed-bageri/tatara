---
"@tatara/cli": patch
---

Postgres apps give every jobs driver the outbox, so `{ executor: inTransaction(tx) }` works with BullMQ, Kafka and inline too. The realtime template exports `unsubscribeUser`.
