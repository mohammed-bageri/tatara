/** In-memory stores for tests and apps without the tables yet; nothing survives a restart. */
import { randomUUID } from "node:crypto";
import type {
	EmailJob,
	EmailJobFilter,
	EmailJobStatus,
	EmailLogEntry,
	EmailQueueStore,
} from "./queue.ts";
import type { SuppressionReason, SuppressionStore } from "./suppression.ts";

export function memoryEmailQueueStore(): EmailQueueStore & {
	jobs: Map<string, EmailJob>;
	sendLog: EmailLogEntry[];
} {
	const jobs = new Map<string, EmailJob>();
	const sendLog: EmailLogEntry[] = [];
	const matches = (job: EmailJob, filter: EmailJobFilter, from: readonly EmailJobStatus[]) =>
		from.includes(job.status) &&
		("ids" in filter
			? filter.ids.includes(job.id)
			: "idempotencyKey" in filter
				? job.idempotencyKey === filter.idempotencyKey
				: job.entityType === filter.entityType && job.entityId === filter.entityId);
	return {
		jobs,
		sendLog,
		async insert(job) {
			for (const existing of jobs.values())
				if (existing.idempotencyKey === job.idempotencyKey) return null;
			const id = randomUUID();
			jobs.set(id, { ...job, id });
			return id;
		},
		async claimDue(now, limit, leaseUntil) {
			const expired = (j: EmailJob) =>
				j.status === "processing" && j.claimedUntil !== null && j.claimedUntil < now;
			const due = [...jobs.values()]
				.filter(
					(j) =>
						expired(j) ||
						(j.status === "pending" && j.scheduledFor <= now && j.nextAttemptAt <= now),
				)
				.sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
				.slice(0, limit);
			for (const job of due)
				Object.assign(job, {
					attempts: expired(job) ? job.attempts + 1 : job.attempts,
					status: "processing",
					claimedUntil: leaseUntil,
					updatedAt: now,
				});
			return due.map((j) => ({ ...j }));
		},
		async update(id, patch) {
			const job = jobs.get(id);
			if (job) Object.assign(job, patch);
		},
		async updateWhere(filter, from, patch) {
			let n = 0;
			for (const job of jobs.values())
				if (matches(job, filter, from)) {
					Object.assign(job, patch);
					n++;
				}
			return n;
		},
		async deleteWhere(filter, from) {
			let n = 0;
			for (const job of [...jobs.values()])
				if (matches(job, filter, from)) {
					jobs.delete(job.id);
					n++;
				}
			return n;
		},
		async get(id) {
			const job = jobs.get(id);
			return job ? { ...job } : null;
		},
		async findByIdempotencyKey(key) {
			for (const job of jobs.values()) if (job.idempotencyKey === key) return { ...job };
			return null;
		},
		async log(entry) {
			sendLog.push(entry);
		},
		async findSent(providerMessageId) {
			const entry = sendLog.find((e) => e.providerMessageId === providerMessageId);
			return entry ? { orgId: entry.orgId, jobId: entry.jobId, recipient: entry.recipient } : null;
		},
	};
}

export function memorySuppressionStore(): SuppressionStore & {
	rows: { orgId: string; hash: string; reason: SuppressionReason; sourceJobId: string | null }[];
} {
	const rows: {
		orgId: string;
		hash: string;
		reason: SuppressionReason;
		sourceJobId: string | null;
	}[] = [];
	return {
		rows,
		async find(orgId, hashes) {
			const out = new Map<string, SuppressionReason>();
			for (const row of rows)
				if (row.orgId === orgId && hashes.includes(row.hash)) out.set(row.hash, row.reason);
			return out;
		},
		async add(entry) {
			if (rows.some((r) => r.orgId === entry.orgId && r.hash === entry.hash)) return;
			rows.push({ ...entry });
		},
	};
}
