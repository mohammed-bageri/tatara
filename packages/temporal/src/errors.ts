/** Temporal can't be reached; HTTP routes map it to 503 so a caller can retry. */
export class TemporalUnavailableError extends Error {
	override readonly name = "TemporalUnavailableError";
}

// gRPC status codes for "the server isn't there or didn't answer in time"
const UNAVAILABLE = 14;
const DEADLINE_EXCEEDED = 4;

/** True when the error (or one in its cause chain) means Temporal couldn't be reached. */
export function isTemporalUnavailable(error: unknown): boolean {
	let current: unknown = error;
	for (let depth = 0; current && depth < 5; depth++) {
		if (typeof current !== "object") return false;
		const { name, code, cause } = current as { name?: unknown; code?: unknown; cause?: unknown };
		if (name === "TransportError" || name === "TemporalUnavailableError") return true;
		if (code === UNAVAILABLE || code === DEADLINE_EXCEEDED) return true;
		current = cause;
	}
	return false;
}
