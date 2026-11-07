import type { InAppContent, NotificationParams, Translate } from "./define.ts";
import type { NotificationRow } from "./store.ts";

function text(
	key: string | null | undefined,
	stored: string | null | undefined,
	params: NotificationParams,
	language: string,
	translate: Translate | undefined,
): string | undefined {
	if (!key) return stored ?? undefined;
	const fallback = stored || key;
	return translate ? translate(language, key, params, fallback) : fallback;
}

/**
 * A stored notification as the reader sees it: `title` and `body` in `language`, translated from
 * their keys (the stored text is the fallback). Rows without keys come back unchanged.
 */
export function localizeNotification<R extends NotificationRow>(
	row: R,
	language: string,
	translate?: Translate,
): R {
	if (!row.titleKey && !row.bodyKey) return row;
	const params = row.params ?? {};
	return {
		...row,
		title: text(row.titleKey, row.title, params, language, translate) ?? "",
		body: text(row.bodyKey, row.body, params, language, translate) ?? null,
	};
}

/** In-app content's title and body in `language`, for what's pushed when it's stored. */
export function renderInApp(
	content: InAppContent,
	language: string,
	translate: Translate | undefined,
): { title: string; body?: string } {
	const params = content.params ?? {};
	const body = text(content.bodyKey, content.body, params, language, translate);
	return {
		title: text(content.titleKey, content.title, params, language, translate) ?? "",
		...(body === undefined ? {} : { body }),
	};
}
