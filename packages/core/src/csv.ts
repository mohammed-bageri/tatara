/** CSV for spreadsheets: RFC 4180 quoting, and by default a UTF-8 BOM and CRLF so Excel reads it. */

// U+FEFF: without it Excel guesses the encoding and garbles Arabic, accents and emoji
const BOM = "\uFEFF";

export interface CsvOptions {
	/** start with a UTF-8 byte order mark (default true) */
	bom?: boolean;
	/** line separator (default "\r\n") */
	eol?: string;
	/** field separator (default ","); cells containing it are quoted */
	delimiter?: string;
}

/** One cell: empty for null/undefined, quoted when it holds the delimiter, a quote, CR or LF. */
export function escapeCsvCell(value: unknown, delimiter = ","): string {
	if (value === null || value === undefined) return "";
	const text = String(value);
	if (/["\r\n]/.test(text) || text.includes(delimiter)) return `"${text.replaceAll('"', '""')}"`;
	return text;
}

/** A header row and data rows as one CSV document (no trailing line break). */
export function toCsv(
	header: readonly unknown[],
	rows: readonly (readonly unknown[])[],
	options: CsvOptions = {},
): string {
	const delimiter = options.delimiter ?? ",";
	const line = (cells: readonly unknown[]) =>
		cells.map((cell) => escapeCsvCell(cell, delimiter)).join(delimiter);
	const lines = [line(header), ...rows.map(line)];
	return (options.bom === false ? "" : BOM) + lines.join(options.eol ?? "\r\n");
}
