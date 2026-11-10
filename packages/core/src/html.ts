import sanitize from "sanitize-html";
import { cleanText } from "./sanitize.ts";

export type HtmlProfile = "text" | "email";

const TEXT_TAGS = [
	"p",
	"br",
	"b",
	"i",
	"strong",
	"em",
	"u",
	"s",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"ul",
	"ol",
	"li",
	"a",
	"blockquote",
	"code",
	"pre",
	"hr",
	"span",
];
const EMAIL_TAGS = [
	...TEXT_TAGS,
	"img",
	"table",
	"thead",
	"tbody",
	"tr",
	"td",
	"th",
	"div",
	"center",
];
// the look email clients need, nothing that loads or positions content
const SAFE_STYLE = {
	color: [/^#[0-9a-f]{3,8}$/i, /^[a-z]+$/i, /^rgba?\([\d\s,.%]+\)$/i],
	"background-color": [/^#[0-9a-f]{3,8}$/i, /^[a-z]+$/i, /^rgba?\([\d\s,.%]+\)$/i],
	"text-align": [/^(left|right|center|justify)$/],
	"font-size": [/^\d+(px|em|rem|%)$/],
	"font-weight": [/^(normal|bold|\d{3})$/],
	padding: [/^[\d\s.]+(px|em)?(\s+[\d.]+(px|em)?){0,3}$/],
	margin: [/^[\d\s.]+(px|em)?(\s+[\d.]+(px|em)?){0,3}$/],
};

export interface HtmlOptions {
	/** the base allow-list (default "text") */
	profile?: HtmlProfile;
	/** more tags to keep */
	tags?: readonly string[];
	/** more attributes to keep, by tag; "*" for every tag */
	attributes?: Readonly<Record<string, readonly string[]>>;
	/** more inline style properties and the values they may take (needs `style` allowed) */
	styles?: Readonly<Record<string, RegExp[]>>;
	/** link schemes (default http, https, mailto) */
	schemes?: readonly string[];
	/** image `src` schemes (default https) */
	imageSchemes?: readonly string[];
}

/**
 * HTML from users (rich text, admin-edited email templates) with only formatting left: no scripts,
 * event handlers, iframes, forms or javascript:/data: links. "email" also keeps images, tables and
 * a few inline styles. Links open safely (rel="noopener noreferrer"). Options add to a profile,
 * never remove its guards. Needs `sanitize-html` installed.
 */
export function sanitizeHtml(
	input: string | null | undefined,
	profileOrOptions: HtmlProfile | HtmlOptions = "text",
): string {
	if (!input) return "";
	const options =
		typeof profileOrOptions === "string" ? { profile: profileOrOptions } : profileOrOptions;
	const email = options.profile === "email";
	const attributes: Record<string, string[]> = {
		a: ["href", "title", "target", "rel"],
		...(email
			? {
					img: ["src", "alt", "width", "height"],
					td: ["colspan", "rowspan"],
					th: ["colspan", "rowspan"],
					"*": ["style", "align"],
				}
			: {}),
	};
	for (const [tag, names] of Object.entries(options.attributes ?? {}))
		attributes[tag] = [...(attributes[tag] ?? []), ...names];
	const styles = { ...(email ? SAFE_STYLE : {}), ...options.styles };
	return sanitize(input, {
		allowedTags: [...(email ? EMAIL_TAGS : TEXT_TAGS), ...(options.tags ?? [])],
		allowedAttributes: attributes,
		allowedStyles: { "*": styles },
		allowedSchemes: [...(options.schemes ?? ["http", "https", "mailto"])],
		allowedSchemesByTag: { img: [...(options.imageSchemes ?? ["https"])] },
		allowProtocolRelative: false,
		transformTags: {
			a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, rel: "noopener noreferrer" } }),
		},
	});
}

const ESCAPED: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };

/**
 * The text of an HTML fragment on one line, for names and subject lines: tags dropped (with the
 * contents of script and style), entities decoded, then `cleanText`. The result is plain text, so
 * escape it when you put it into HTML. Needs `sanitize-html` installed.
 */
export function stripHtml(input: string | null | undefined): string {
	if (!input) return "";
	const text = sanitize(input, { allowedTags: [], allowedAttributes: {} })
		.replace(/&(lt|gt|quot|#39);/g, (entity) => ESCAPED[entity] ?? entity)
		.replace(/&amp;/g, "&");
	return cleanText(text);
}
