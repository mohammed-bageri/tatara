---
"@tatara/jobs": minor
---

A job carries the id of the request that enqueued it: `enqueue(topic, data, { requestId })`, `ctx.requestId` in the consumer, and on the job's log lines. The Postgres driver adds a nullable `request_id` column to its table.
