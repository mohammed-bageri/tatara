import { describe, expect, it } from "vitest";
import {
	civilDateIn,
	civilDayString,
	civilMonthIn,
	civilTimeIn,
	dayStartInZone,
	isValidTimeZone,
	monthStartInZone,
	zonedTimeCandidates,
	zonedTimeToInstant,
} from "./time.ts";

describe("civilMonthIn()", () => {
	it("reads the civil month in the org's zone, not UTC", () => {
		// 23:30 UTC on 31 March is already 02:30 on 1 April in Riyadh (UTC+3).
		const instant = new Date("2026-03-31T23:30:00Z");

		expect(civilMonthIn("UTC", instant)).toEqual({ year: 2026, month: 3 });
		expect(civilMonthIn("Asia/Riyadh", instant)).toEqual({ year: 2026, month: 4 });
	});
});

describe("monthStartInZone()", () => {
	it("returns the UTC instant at which the civil month starts", () => {
		// Midnight 1 April in Riyadh is 21:00 on 31 March UTC.
		expect(monthStartInZone("Asia/Riyadh", 2026, 4).toISOString()).toBe("2026-03-31T21:00:00.000Z");
	});

	it("normalises a month outside 1-12 so callers can subtract directly", () => {
		// `nowMonth - 5` from February is -3 — the trend window's natural form.
		expect(monthStartInZone("UTC", 2026, -3).toISOString()).toBe("2025-09-01T00:00:00.000Z");
	});

	it("handles a zone with a non-hour offset", () => {
		// Kathmandu is UTC+5:45 — a whole-hour correction would be 45 minutes out.
		expect(monthStartInZone("Asia/Kathmandu", 2026, 4).toISOString()).toBe(
			"2026-03-31T18:15:00.000Z",
		);
	});
});

describe("civilDateIn()", () => {
	it("reads day and weekday in the org's zone, not UTC", () => {
		// 2026-03-04 22:00 UTC is Wednesday the 4th in UTC but Thursday the 5th in Riyadh.
		const at = new Date("2026-03-04T22:00:00.000Z");
		expect(civilDateIn("UTC", at)).toEqual({ year: 2026, month: 3, day: 4, weekday: 3 });
		expect(civilDateIn("Asia/Riyadh", at)).toEqual({ year: 2026, month: 3, day: 5, weekday: 4 });
	});

	it("uses Date#getDay numbering — Sunday is 0", () => {
		expect(civilDateIn("UTC", new Date("2026-03-01T12:00:00.000Z")).weekday).toBe(0);
	});
});

describe("dayStartInZone()", () => {
	it("starts the day at the org's midnight, not the server's", () => {
		// 22:30 UTC on 27 September is already 01:30 on the 28th in Riyadh, so
		// Riyadh's day began at 21:00 UTC; a UTC server would say 00:00 on the 27th.
		const at = new Date("2026-09-27T22:30:00.000Z");
		expect(dayStartInZone("Asia/Riyadh", at).toISOString()).toBe("2026-09-27T21:00:00.000Z");
		expect(dayStartInZone("UTC", at).toISOString()).toBe("2026-09-27T00:00:00.000Z");
	});

	it("follows a zone west of Greenwich back into the previous UTC day", () => {
		// 03:00 UTC on 1 March is still 22:00 on 28 February in New York (UTC-5).
		const at = new Date("2026-03-01T03:00:00.000Z");
		expect(dayStartInZone("America/New_York", at).toISOString()).toBe("2026-02-28T05:00:00.000Z");
	});

	it("handles a zone with a non-hour offset", () => {
		// Kathmandu is UTC+5:45.
		const at = new Date("2026-04-10T12:00:00.000Z");
		expect(dayStartInZone("Asia/Kathmandu", at).toISOString()).toBe("2026-04-09T18:15:00.000Z");
	});
});

describe("civil day string", () => {
	describe("civilDayString", () => {
		it("follows the zone's calendar day", () => {
			expect(civilDayString("Asia/Riyadh", new Date("2026-11-04T21:30:00Z"))).toBe("2026-11-05");
			expect(civilDayString("UTC", new Date("2026-11-04T21:30:00Z"))).toBe("2026-11-04");
			expect(civilDayString("Pacific/Kiritimati", new Date("2026-11-05T10:30:00Z"))).toBe(
				"2026-11-06",
			);
		});

		it("zero-pads month and day", () => {
			expect(civilDayString("UTC", new Date("2026-01-02T00:00:00Z"))).toBe("2026-01-02");
		});
	});
});

/**
 * Wall-clock helpers next to the civil-month ones: turning a civil date and time
 * in a zone into an instant (DST-aware), reading the wall clock back, and telling
 * a real IANA zone from free text.
 */
describe("civil time", () => {
	describe("zonedTimeToInstant()", () => {
		it("places 09:00 Riyadh three hours before UTC", () => {
			expect(zonedTimeToInstant("Asia/Riyadh", 2026, 8, 13, 9, 0, 0).toISOString()).toBe(
				"2026-09-13T06:00:00.000Z",
			);
		});

		it("follows London's clock change", () => {
			// Friday 27 March is GMT; Monday 30 March is BST (UTC+1).
			expect(zonedTimeToInstant("Europe/London", 2026, 2, 27, 9, 0, 0).toISOString()).toBe(
				"2026-03-27T09:00:00.000Z",
			);
			expect(zonedTimeToInstant("Europe/London", 2026, 2, 30, 9, 0, 0).toISOString()).toBe(
				"2026-03-30T08:00:00.000Z",
			);
		});

		it("converts correctly when a DST change lies between the naive and true instant", () => {
			// New York springs forward at 02:00 on 8 March 2026 (EST -5 -> EDT -4).
			expect(zonedTimeToInstant("America/New_York", 2026, 2, 8, 3, 30, 0).toISOString()).toBe(
				"2026-03-08T07:30:00.000Z",
			);
			expect(zonedTimeToInstant("America/New_York", 2026, 2, 8, 9, 0, 0).toISOString()).toBe(
				"2026-03-08T13:00:00.000Z",
			);
			expect(zonedTimeToInstant("Europe/London", 2026, 2, 29, 9, 0, 0).toISOString()).toBe(
				"2026-03-29T08:00:00.000Z",
			);
		});

		it("shifts a nonexistent (spring-forward gap) wall time forward by the gap", () => {
			// 02:30 on 8 March never happens in New York; it reads as 03:30 EDT.
			expect(zonedTimeToInstant("America/New_York", 2026, 2, 8, 2, 30, 0).toISOString()).toBe(
				"2026-03-08T07:30:00.000Z",
			);
		});

		it("takes the earlier instant for an ambiguous (fall-back overlap) wall time", () => {
			// 01:30 on 1 November happens twice in New York; the first is EDT (05:30Z).
			expect(zonedTimeToInstant("America/New_York", 2026, 10, 1, 1, 30, 0).toISOString()).toBe(
				"2026-11-01T05:30:00.000Z",
			);
		});

		it("normalises an overflowing day like Date.UTC", () => {
			expect(zonedTimeToInstant("UTC", 2026, 0, 32, 0, 0, 0).toISOString()).toBe(
				"2026-02-01T00:00:00.000Z",
			);
		});
	});

	describe("zonedTimeCandidates()", () => {
		const iso = (dates: Date[]) => dates.map((d) => d.toISOString());

		it("names one instant for a normal wall time (Riyadh, London in summer)", () => {
			expect(iso(zonedTimeCandidates("Asia/Riyadh", 2027, 0, 20, 9, 0, 0))).toEqual([
				"2027-01-20T06:00:00.000Z",
			]);
			expect(iso(zonedTimeCandidates("Europe/London", 2027, 6, 1, 9, 0, 0))).toEqual([
				"2027-07-01T08:00:00.000Z",
			]);
		});

		it("names none in a spring-forward gap", () => {
			expect(zonedTimeCandidates("Europe/London", 2027, 2, 28, 1, 30, 0)).toEqual([]);
			expect(zonedTimeCandidates("America/New_York", 2027, 2, 14, 2, 30, 0)).toEqual([]);
		});

		it("names both instants of a fall-back overlap, earliest first", () => {
			expect(iso(zonedTimeCandidates("America/New_York", 2027, 10, 7, 1, 30, 0))).toEqual([
				"2027-11-07T05:30:00.000Z",
				"2027-11-07T06:30:00.000Z",
			]);
		});
	});

	describe("civilTimeIn()", () => {
		it("reads the wall clock in the zone", () => {
			expect(civilTimeIn("Asia/Riyadh", new Date("2026-09-10T22:15:30.000Z"))).toEqual({
				hour: 1,
				minute: 15,
				second: 30,
			});
		});

		it("reads midnight as hour 0, not 24", () => {
			expect(civilTimeIn("UTC", new Date("2026-09-10T00:00:00.000Z"))).toEqual({
				hour: 0,
				minute: 0,
				second: 0,
			});
		});
	});

	describe("isValidTimeZone()", () => {
		it("accepts IANA zones and refuses everything else", () => {
			expect(isValidTimeZone("Europe/London")).toBe(true);
			expect(isValidTimeZone("Asia/Riyadh")).toBe(true);
			expect(isValidTimeZone("Mars/Olympus")).toBe(false);
			expect(isValidTimeZone("")).toBe(false);
			expect(isValidTimeZone("   ")).toBe(false);
		});
	});
});
