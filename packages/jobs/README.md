# @tatara/jobs

Part of [tatara](https://github.com/mohammed-bageri/tatara).

## Enqueue in a transaction

`enqueue(topic, data, { executor: inTransaction(tx) })` stores the job only if `tx` commits. The
Postgres driver writes it in its `tatara.jobs` table. BullMQ, Kafka and inline use a transactional
outbox in the same database: give the driver `outbox: { db: pool, logger }` and the job is written
as a `tatara.job_outbox` row in `tx`. After commit it is forwarded to the queue and deleted. A
rollback leaves nothing. Without an `outbox`, BullMQ and Kafka throw on an executor and inline runs
the job at once.

- The process that enqueued forwards its rows for 10s after its last enqueue (`fastPathMs`), and
  every worker forwards all committed rows of its queue, every `pollMs` (200ms).
- Forwarding is at least once: a crash between sending and deleting sends the job again once its
  claim lapses (1 minute). BullMQ drops a repeat while it still holds the job id; handlers must be
  idempotent anyway.
- `InlineDriver.drain()` forwards the committed rows first, so tests see the job.

## BullMQ retention

`bullmqDriver({ removeOnComplete, removeOnFail })` takes BullMQ's values (a count, `{ age, count }`
or a boolean) for the queue's finished and failed attempts; the defaults are 1000 and 5000. Dead
jobs in `<name>-dead` are always kept.
