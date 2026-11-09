import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import { GoogleAuthManager } from "./auth";
import { ParsedTask } from "./parser";

export const GOOGLE_TASKS_API_BASE = "https://tasks.googleapis.com/tasks/v1";

export interface GoogleTaskList {
	kind: string;
	id: string;
	etag: string;
	title: string;
	updated?: string;
	selfLink?: string;
}

export interface GoogleTaskListsResponse {
	kind: string;
	etag: string;
	nextPageToken?: string;
	items?: GoogleTaskList[];
}

export interface GoogleTask {
	kind: string;
	id: string;
	etag: string;
	title: string;
	updated?: string;
	selfLink?: string;
	parent?: string;
	position?: string;
	notes?: string;
	status: "needsAction" | "completed";
	due?: string;
	completed?: string;
}

export interface CreateTaskInput {
	title: string;
	due?: string;
	notes?: string;
}

export class GoogleTasksApiClient {
	/** Cache mapping normalized category title -> TaskList ID */
	private listCache = new Map<string, string>();
	/** In-flight promises for resolving/creating a category list to prevent race conditions */
	private pendingListResolutions = new Map<string, Promise<string>>();

	constructor(private authManager: GoogleAuthManager) {}

	/**
	 * Clears the internal TaskList ID cache.
	 */
	public clearCache(): void {
		this.listCache.clear();
		this.pendingListResolutions.clear();
	}

	/**
	 * Synchronizes a parsed Markdown task to Google Tasks:
	 * 1. Resolves or dynamically creates the Google Tasks `TaskList` matching `task.category`.
	 * 2. Inserts the task with `title` and optional RFC 3339 `due` date.
	 * 3. Returns the created `GoogleTask` (including its `id`).
	 */
	public async syncParsedTask(task: ParsedTask): Promise<GoogleTask> {
		const listId = await this.getOrCreateTaskList(task.category);

		try {
			return await this.createTask(listId, {
				title: task.title,
				...(task.due ? { due: task.due } : {}),
			});
		} catch (err) {
			// If the cached list was deleted remotely in Google Tasks (404), re-create and retry once
			if (err instanceof Error && err.message.includes("HTTP 404")) {
				this.listCache.delete(this.normalizeCategoryKey(task.category));
				const freshListId = await this.getOrCreateTaskList(task.category);
				return await this.createTask(freshListId, {
					title: task.title,
					...(task.due ? { due: task.due } : {}),
				});
			}
			throw err;
		}
	}

	/**
	 * Resolves the Google `TaskList` ID for a given category title,
	 * fetching existing lists or creating a new one dynamically if it doesn't exist.
	 */
	public async getOrCreateTaskList(categoryTitle: string): Promise<string> {
		const trimmedTitle = categoryTitle.trim();
		const key = this.normalizeCategoryKey(trimmedTitle);

		const cachedId = this.listCache.get(key);
		if (cachedId) {
			return cachedId;
		}

		const inFlight = this.pendingListResolutions.get(key);
		if (inFlight) {
			return inFlight;
		}

		const resolutionPromise = (async () => {
			const allLists = await this.fetchAllTaskLists();

			// Populate cache with all existing lists
			for (const list of allLists) {
				if (list.title && list.id) {
					this.listCache.set(this.normalizeCategoryKey(list.title), list.id);
				}
			}

			const existingId = this.listCache.get(key);
			if (existingId) {
				return existingId;
			}

			// Create the TaskList dynamically if not found
			const createdList = await this.createTaskList(trimmedTitle);
			this.listCache.set(key, createdList.id);
			return createdList.id;
		})().finally(() => {
			this.pendingListResolutions.delete(key);
		});

		this.pendingListResolutions.set(key, resolutionPromise);
		return resolutionPromise;
	}

	/**
	 * Fetches all `TaskList`s for the authenticated user, handling pagination.
	 */
	public async fetchAllTaskLists(): Promise<GoogleTaskList[]> {
		const results: GoogleTaskList[] = [];
		let pageToken: string | undefined;

		do {
			const params = new URLSearchParams({ maxResults: "100" });
			if (pageToken) {
				params.set("pageToken", pageToken);
			}

			const response = await this.authorizedRequest({
				url: `${GOOGLE_TASKS_API_BASE}/users/@me/lists?${params.toString()}`,
				method: "GET",
			});

			const data = response.json as GoogleTaskListsResponse;
			if (Array.isArray(data.items)) {
				results.push(...data.items);
			}
			pageToken = data.nextPageToken;
		} while (pageToken);

		return results;
	}

	/**
	 * Creates a new `TaskList` with the given title.
	 */
	public async createTaskList(title: string): Promise<GoogleTaskList> {
		const response = await this.authorizedRequest({
			url: `${GOOGLE_TASKS_API_BASE}/users/@me/lists`,
			method: "POST",
			body: JSON.stringify({ title }),
		});

		return response.json as GoogleTaskList;
	}

	/**
	 * Inserts a new task into the specified `TaskList`.
	 */
	public async createTask(taskListId: string, input: CreateTaskInput): Promise<GoogleTask> {
		const payload: Record<string, string> = {
			title: input.title,
		};
		if (input.due) {
			payload.due = input.due;
		}
		if (input.notes) {
			payload.notes = input.notes;
		}

		const response = await this.authorizedRequest({
			url: `${GOOGLE_TASKS_API_BASE}/lists/${encodeURIComponent(taskListId)}/tasks`,
			method: "POST",
			body: JSON.stringify(payload),
		});

		return response.json as GoogleTask;
	}

	private normalizeCategoryKey(title: string): string {
		return title.trim().toLowerCase();
	}

	private async authorizedRequest(
		options: Omit<RequestUrlParam, "headers" | "throw">
	): Promise<RequestUrlResponse> {
		const accessToken = await this.authManager.getValidAccessToken();

		const response = await requestUrl({
			...options,
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			throw: false,
		});

		if (response.status < 200 || response.status >= 300) {
			throw new Error(
				`Google Tasks API error (HTTP ${response.status}): ${response.text}`
			);
		}

		return response;
	}
}
