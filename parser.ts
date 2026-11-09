export const DEFAULT_CATEGORY = "HOY";

export interface ParsedTask {
	/** 0-based line number in the document */
	lineNumber: number;
	/** Original full line text */
	originalLine: string;
	/** Clean task title with #task, #<category>, #YYYY-MM-DD, and %%...%% comments stripped */
	title: string;
	/** Target Google Tasks TaskList title (defaults to "HOY") */
	category: string;
	/** Optional RFC 3339 due date string (e.g., "2026-11-15T00:00:00.000Z") */
	due?: string;
	/** Optional raw YYYY-MM-DD date string */
	rawDate?: string;
}

const UNCHECKED_TASK_REGEX = /^(\s*-\s\[ \]\s+)(.*)$/;
const GTASK_SYNC_COMMENT_REGEX = /%%gtask:([^%\s]+)%%/;
const INTERNAL_COMMENT_REGEX = /%%.*?%%/g;
const TASK_TAG_REGEX = /^#task$/i;
const DATE_TAG_REGEX = /^#(\d{4}-\d{2}-\d{2})$/;
const CATEGORY_TAG_REGEX = /^#([^\s#]+)$/;

/**
 * Checks whether a line already contains a `%%gtask:<TASK_ID>%%` sync footprint.
 */
export function hasSyncFootprint(line: string): boolean {
	return GTASK_SYNC_COMMENT_REGEX.test(line);
}

/**
 * Extracts the Google Task ID from a line if it already has a `%%gtask:<TASK_ID>%%` footprint.
 */
export function extractSyncId(line: string): string | null {
	const match = line.match(GTASK_SYNC_COMMENT_REGEX);
	return match ? match[1] : null;
}

/**
 * Validates a YYYY-MM-DD string as a real calendar date and converts it to RFC 3339 format.
 */
export function toRfc3339DueDate(dateStr: string): string | null {
	const parts = dateStr.split("-").map(Number);
	if (parts.length !== 3) {
		return null;
	}
	const [year, month, day] = parts;
	if (month < 1 || month > 12 || day < 1 || day > 31) {
		return null;
	}
	const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
	if (
		isNaN(date.getTime()) ||
		date.getUTCFullYear() !== year ||
		date.getUTCMonth() !== month - 1 ||
		date.getUTCDate() !== day
	) {
		return null;
	}
	return date.toISOString();
}

/**
 * Parses a single Markdown line into a `ParsedTask` if it is an unsynced, unchecked `#task` line.
 * Returns `null` if the line does not match or is already synced.
 */
export function parseTaskLine(
	line: string,
	lineNumber = 0,
	defaultCategory: string = DEFAULT_CATEGORY
): ParsedTask | null {
	// 1. Ignore lines that already have a %%gtask:...%% footprint
	if (hasSyncFootprint(line)) {
		return null;
	}

	// 2. Detect unchecked tasks: - [ ] ...
	const taskMatch = line.match(UNCHECKED_TASK_REGEX);
	if (!taskMatch) {
		return null;
	}

	const rawContent = taskMatch[2];

	// 3. Strip any internal Obsidian %%...%% comments
	const contentWithoutComments = rawContent.replace(INTERNAL_COMMENT_REGEX, " ").trim();
	if (!contentWithoutComments) {
		return null;
	}

	// 4. Tokenize and parse order-independent tags (#task, #YYYY-MM-DD, #<category>)
	const tokens = contentWithoutComments.split(/\s+/);
	let hasTaskTag = false;
	let category: string | undefined;
	let due: string | undefined;
	let rawDate: string | undefined;
	const titleTokens: string[] = [];

	for (const token of tokens) {
		if (!token) continue;

		if (TASK_TAG_REGEX.test(token)) {
			hasTaskTag = true;
			continue;
		}

		const dateMatch = token.match(DATE_TAG_REGEX);
		if (dateMatch && !due) {
			const rfc3339 = toRfc3339DueDate(dateMatch[1]);
			if (rfc3339) {
				rawDate = dateMatch[1];
				due = rfc3339;
				continue;
			}
		}

		const categoryMatch = token.match(CATEGORY_TAG_REGEX);
		if (categoryMatch && !category) {
			category = categoryMatch[1];
			continue;
		}

		titleTokens.push(token);
	}

	// Must contain the anchor tag #task
	if (!hasTaskTag) {
		return null;
	}

	const title = titleTokens.join(" ").trim();
	// Do not sync tasks that have no title text yet (e.g., while user is mid-typing `- [ ] #task `)
	if (!title) {
		return null;
	}

	return {
		lineNumber,
		originalLine: line,
		title,
		category: category || defaultCategory,
		...(due ? { due, rawDate } : {}),
	};
}

/**
 * Scans an entire Markdown document (or array of lines) and returns all unsynced `#task` items.
 */
export function parseTasksFromContent(
	content: string,
	defaultCategory: string = DEFAULT_CATEGORY
): ParsedTask[] {
	const lines = content.split(/\r?\n/);
	const tasks: ParsedTask[] = [];

	for (let i = 0; i < lines.length; i++) {
		const parsed = parseTaskLine(lines[i], i, defaultCategory);
		if (parsed) {
			tasks.push(parsed);
		}
	}

	return tasks;
}

/**
 * Formats the inline sync footprint suffix (` %%gtask:<TASK_ID>%%`).
 */
export function formatSyncFootprint(taskId: string): string {
	return `%%gtask:${taskId}%%`;
}

/**
 * Appends the `%%gtask:<TASK_ID>%%` inline comment to a task line idempotently.
 */
export function appendSyncFootprint(line: string, taskId: string): string {
	if (hasSyncFootprint(line)) {
		return line;
	}
	const trimmedRight = line.replace(/\s+$/, "");
	return `${trimmedRight} ${formatSyncFootprint(taskId)}`;
}
