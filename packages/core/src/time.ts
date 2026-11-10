/**
 * Calendar maths in a given IANA timezone (an organisation's, a user's), not the server's: civil
 * months and days, wall-clock times to instants (DST-aware), and back. Uses only `Intl`.
 */

/** The civil (year, 1-based month) an instant falls in, in `zone`. */
export function civilMonthIn(zone: string, at: Date): { year: number; month: number } {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: zone,
		year: "numeric",
		month: "numeric",
	}).formatToParts(at);
	const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
	return { year: get("year"), month: get("month") };
}

/**
 * The full civil date an instant falls on in `zone`: 1-based month, day of month,
 * and weekday (0 = Sunday … 6 = Saturday, matching `Date#getDay`).
 */
export function civilDateIn(
	zone: string,
	at: Date,
): { year: number; month: number; day: number; weekday: number } {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: zone,
		year: "numeric",
		month: "numeric",
		day: "numeric",
		weekday: "short",
	}).formatToParts(at);
	const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
	const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
	return {
		year: Number(get("year")),
		month: Number(get("month")),
		day: Number(get("day")),
		weekday,
	};
}

/**
 * The UTC instant at which the given civil month starts in `zone`. `month` is
 * 1-based and may fall outside 1–12; it is normalised first, so callers can pass
 * `nowMonth - 5` directly.
 */
export function monthStartInZone(zone: string, year: number, month: number): Date {
	const zeroBased = month - 1;
	const y = year + Math.floor(zeroBased / 12);
	const m = ((zeroBased % 12) + 12) % 12;
	return civilMidnightInZone(zone, y, m, 1);
}

/**
 * The UTC instant at which the civil day containing `at` started in `zone`.
 * A server running in UTC would otherwise start a Riyadh day three hours late.
 */
export function dayStartInZone(zone: string, at: Date): Date {
	const { year, month, day } = civilDateIn(zone, at);
	return civilMidnightInZone(zone, year, month - 1, day);
}

/**
 * Midnight of a civil date in `zone`, as a UTC instant. `zeroBasedMonth` is
 * 0–11, as `Date.UTC` takes it.
 */
function civilMidnightInZone(
	zone: string,
	year: number,
	zeroBasedMonth: number,
	day: number,
): Date {
	return zonedTimeToInstant(zone, year, zeroBasedMonth, day, 0, 0, 0);
}

/** Milliseconds `zone` is ahead of UTC at instant `at` (negative when behind). */
function zoneOffsetMs(zone: string, at: Date): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: zone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).formatToParts(at);
	const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
	const seenAsUtc = Date.UTC(
		get("year"),
		get("month") - 1,
		get("day"),
		get("hour"),
		get("minute"),
		get("second"),
	);
	// Whole seconds only: `at` may carry milliseconds the formatter drops.
	return seenAsUtc - Math.floor(at.getTime() / 1000) * 1000;
}

const DAY_MS = 86_400_000;

/**
 * Every UTC instant a civil date and wall-clock time names in `zone`, earliest
 * first: one normally, two in a fall-back overlap (the wall time happens twice),
 * none in a spring-forward gap (it never happens). `zeroBasedMonth` is 0–11 and
 * may overflow (`Date.UTC` normalises it), as may `day`.
 *
 * The zone's offset a day before and a day after the naive wall time are the
 * only offsets that can apply (no zone changes offset twice within 48 hours);
 * each is kept when the zone really has that offset at `naive - offset`.
 *
 * Throws RangeError for an invalid `zone`.
 */
export function zonedTimeCandidates(
	zone: string,
	year: number,
	zeroBasedMonth: number,
	day: number,
	hour: number,
	minute: number,
	second: number,
): Date[] {
	const naive = Date.UTC(year, zeroBasedMonth, day, hour, minute, second);
	const before = zoneOffsetMs(zone, new Date(naive - DAY_MS));
	const after = zoneOffsetMs(zone, new Date(naive + DAY_MS));
	return [...new Set([before, after])]
		.map((offset) => naive - offset)
		.filter((instant) => zoneOffsetMs(zone, new Date(instant)) === naive - instant)
		.sort((a, b) => a - b)
		.map((instant) => new Date(instant));
}

/**
 * A civil date and wall-clock time in `zone`, as a UTC instant, never refusing
 * (see `zonedTimeCandidates`):
 * - one candidate (the normal case): that one;
 * - two (fall-back overlap): the earlier instant;
 * - none (spring-forward gap): the pre-change offset is applied, so the time
 *   shifts forward by the gap (02:30 reads as 03:30 in New York on the
 *   spring-forward day).
 *
 * Throws RangeError for an invalid `zone`.
 */
export function zonedTimeToInstant(
	zone: string,
	year: number,
	zeroBasedMonth: number,
	day: number,
	hour: number,
	minute: number,
	second: number,
): Date {
	const [first] = zonedTimeCandidates(zone, year, zeroBasedMonth, day, hour, minute, second);
	if (first) return first;
	const naive = Date.UTC(year, zeroBasedMonth, day, hour, minute, second);
	return new Date(naive - zoneOffsetMs(zone, new Date(naive - DAY_MS)));
}

/** The wall-clock time an instant shows in `zone` (24-hour clock). Throws RangeError for an invalid `zone`. */
export function civilTimeIn(
	zone: string,
	at: Date,
): { hour: number; minute: number; second: number } {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: zone,
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).formatToParts(at);
	const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
	return { hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** An IANA zone the runtime can actually format in, e.g. `Asia/Riyadh`. */
export function isValidTimeZone(zone: string): boolean {
	if (zone.trim().length === 0) return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: zone });
		return true;
	} catch {
		return false;
	}
}

/** The civil date an instant falls on in `zone`, as `YYYY-MM-DD`. */
export function civilDayString(zone: string, at: Date): string {
	const { year, month, day } = civilDateIn(zone, at);
	return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
