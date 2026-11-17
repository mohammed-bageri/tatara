---
"@tatara/jobs": minor
---

`enqueue(…, { executor: inTransaction(tx) })` works with every driver: `bullmqDriver`, `kafkaDriver` and `inlineDriver` take `outbox: { db, logger }`, write the job as a `tatara.job_outbox` row in the caller's transaction and forward it once it commits (`jobOutbox`). `InlineDriver.drain()` forwards committed rows first. `bullmqDriver` takes `removeOnComplete` and `removeOnFail`.
