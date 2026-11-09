import {
	App,
	debounce,
	Editor,
	MarkdownFileInfo,
	MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
} from "obsidian";
import { GoogleAuthManager, OAuthTokenState, REDIRECT_URI } from "./auth";
import {
	DEFAULT_CATEGORY,
	formatSyncFootprint,
	hasSyncFootprint,
	ParsedTask,
	parseTaskLine,
} from "./parser";
import { GoogleTasksApiClient } from "./tasksApi";

export interface GTasksPluginSettings extends OAuthTokenState {
	defaultCategory: string;
	autoSync: boolean;
	autoSyncDebounceMs: number;
}

export const DEFAULT_SETTINGS: GTasksPluginSettings = {
	clientId: "",
	clientSecret: "",
	accessToken: "",
	refreshToken: "",
	tokenExpiry: 0,
	defaultCategory: DEFAULT_CATEGORY,
	autoSync: true,
	autoSyncDebounceMs: 2000,
};

export default class ObsidianGTasksPlugin extends Plugin {
	public settings: GTasksPluginSettings = { ...DEFAULT_SETTINGS };
	public authManager!: GoogleAuthManager;
	public tasksApi!: GoogleTasksApiClient;

	/** Tracks tasks currently being created in Google Tasks to prevent duplicate API requests */
	private inFlightTaskKeys = new Set<string>();
	/** Flag to suppress re-triggering editor-change when the plugin writes %%gtask:<ID>%% */
	private isApplyingSyncFootprint = false;
	/** Debounced editor auto-sync handler */
	private debouncedEditorSync!: (editor: Editor, info: MarkdownView | MarkdownFileInfo) => void;
	/** Per-file debounce timers for background vault modifications */
	private vaultModifyTimers = new Map<string, ReturnType<typeof setTimeout>>();

	public async onload(): Promise<void> {
		await this.loadSettings();

		this.authManager = new GoogleAuthManager(
			() => this.settings,
			async (updatedTokens) => {
				Object.assign(this.settings, updatedTokens);
				await this.saveSettings();
			}
		);

		this.tasksApi = new GoogleTasksApiClient(this.authManager);
		this.configureDebouncedSync();

		// Command Palette: "Sync tasks in current file"
		this.addCommand({
			id: "sync-tasks-in-current-file",
			name: "Sync tasks in current file",
			editorCallback: async (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
				await this.syncEditorTasks(editor, ctx.file ?? null, { notifyUser: true });
			},
		});

		// Debounced automatic listener on editor changes (preserves cursor position)
		this.registerEvent(
			this.app.workspace.on("editor-change", (editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
				if (this.isApplyingSyncFootprint || !this.settings.autoSync) {
					return;
				}
				if (!this.authManager.isAuthenticated()) {
					return;
				}
				this.debouncedEditorSync(editor, info);
			})
		);

		// Fallback debounced listener for vault modifications outside the active editor
		this.registerEvent(
			this.app.vault.on("modify", (abstractFile) => {
				if (this.isApplyingSyncFootprint || !this.settings.autoSync) {
					return;
				}
				if (!(abstractFile instanceof TFile) || abstractFile.extension !== "md") {
					return;
				}
				if (!this.authManager.isAuthenticated()) {
					return;
				}

				// If this file is currently open in an active MarkdownView editor,
				// let the editor-change pipeline handle it so cursor state is preserved.
				const activeEditor = this.findEditorForFile(abstractFile);
				if (activeEditor) {
					return;
				}

				this.scheduleBackgroundFileSync(abstractFile);
			})
		);

		this.addSettingTab(new GTasksSettingTab(this.app, this));
	}

	public onunload(): void {
		this.authManager?.stopActiveServer();
		for (const timer of this.vaultModifyTimers.values()) {
			clearTimeout(timer);
		}
		this.vaultModifyTimers.clear();
	}

	public configureDebouncedSync(): void {
		this.debouncedEditorSync = debounce(
			(editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
				void this.syncEditorTasks(editor, info.file ?? null, { notifyUser: false });
			},
			this.settings.autoSyncDebounceMs,
			true
		);
	}

	public async loadSettings(): Promise<void> {
		const loaded = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
	}

	public async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/**
	 * Scans an Editor instance for unsynced `#task` lines, creates them in Google Tasks,
	 * and appends `%%gtask:<TASK_ID>%%` inline without disrupting the user's cursor position.
	 */
	public async syncEditorTasks(
		editor: Editor,
		file: TFile | null,
		options: { notifyUser: boolean }
	): Promise<number> {
		if (!this.authManager.isAuthenticated()) {
			if (options.notifyUser) {
				new Notice("Please authenticate with Google Tasks in plugin settings first.");
			}
			return 0;
		}

		const lineCount = editor.lineCount();
		const tasksToSync: ParsedTask[] = [];
		const defaultCategory = this.settings.defaultCategory.trim() || DEFAULT_CATEGORY;

		for (let i = 0; i < lineCount; i++) {
			const line = editor.getLine(i);
			const parsed = parseTaskLine(line, i, defaultCategory);
			if (parsed) {
				tasksToSync.push(parsed);
			}
		}

		if (tasksToSync.length === 0) {
			if (options.notifyUser) {
				new Notice("No unsynced #task items found in the current file.");
			}
			return 0;
		}

		let syncedCount = 0;
		const fileId = file?.path ?? "active-editor";

		for (const task of tasksToSync) {
			const inFlightKey = `${fileId}::${task.originalLine.trim()}`;
			if (this.inFlightTaskKeys.has(inFlightKey)) {
				continue;
			}

			this.inFlightTaskKeys.add(inFlightKey);
			try {
				const createdTask = await this.tasksApi.syncParsedTask(task);
				const applied = this.appendFootprintInEditor(editor, task, createdTask.id);
				if (applied) {
					syncedCount++;
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				console.error("[obsidian-gtasks] Failed to sync task:", task.title, err);
				new Notice(`Google Tasks sync error: ${message}`);
			} finally {
				this.inFlightTaskKeys.delete(inFlightKey);
			}
		}

		if (options.notifyUser && syncedCount > 0) {
			new Notice(
				`Synced ${syncedCount} task${syncedCount === 1 ? "" : "s"} to Google Tasks.`
			);
		}

		return syncedCount;
	}

	/**
	 * Appends ` %%gtask:<TASK_ID>%%` to the end of the target task line in the editor
	 * using targeted `editor.replaceRange` so cursor position and scroll state are preserved.
	 */
	private appendFootprintInEditor(
		editor: Editor,
		task: ParsedTask,
		googleTaskId: string
	): boolean {
		const targetLineIndex = this.locateTaskLineInEditor(editor, task);
		if (targetLineIndex === null) {
			return false;
		}

		const currentLine = editor.getLine(targetLineIndex);
		if (hasSyncFootprint(currentLine)) {
			return false;
		}

		const trimmedLength = currentLine.replace(/\s+$/, "").length;
		const suffix = ` ${formatSyncFootprint(googleTaskId)}`;

		// Capture cursor state before edit in case the cursor is at the insertion point
		const cursorBefore = editor.getCursor();
		const hasSelection = editor.somethingSelected();

		this.isApplyingSyncFootprint = true;
		try {
			editor.replaceRange(
				suffix,
				{ line: targetLineIndex, ch: trimmedLength },
				{ line: targetLineIndex, ch: currentLine.length }
			);

			// If the user's cursor was right at the end of the synced line without a selection,
			// keep the cursor before the newly appended %%gtask:...%% comment.
			if (
				!hasSelection &&
				cursorBefore.line === targetLineIndex &&
				cursorBefore.ch >= trimmedLength
			) {
				editor.setCursor({ line: targetLineIndex, ch: cursorBefore.ch });
			}
		} finally {
			this.isApplyingSyncFootprint = false;
		}

		return true;
	}

	/**
	 * Finds the current line number of a `ParsedTask` in the editor, accounting for
	 * potential line insertions/deletions while the network request was in flight.
	 */
	private locateTaskLineInEditor(editor: Editor, task: ParsedTask): number | null {
		const lineCount = editor.lineCount();
		const defaultCategory = this.settings.defaultCategory.trim() || DEFAULT_CATEGORY;

		// 1. Check original line index first (fast path)
		if (task.lineNumber >= 0 && task.lineNumber < lineCount) {
			const candidate = editor.getLine(task.lineNumber);
			if (!hasSyncFootprint(candidate)) {
				if (candidate === task.originalLine) {
					return task.lineNumber;
				}
				const reparsed = parseTaskLine(candidate, task.lineNumber, defaultCategory);
				if (
					reparsed &&
					reparsed.title === task.title &&
					reparsed.category === task.category &&
					reparsed.due === task.due
				) {
					return task.lineNumber;
				}
			}
		}

		// 2. Fallback: scan all lines in case lines were added/removed above during the API call
		for (let i = 0; i < lineCount; i++) {
			const candidate = editor.getLine(i);
			if (candidate === task.originalLine && !hasSyncFootprint(candidate)) {
				return i;
			}
		}

		return null;
	}

	private findEditorForFile(file: TFile): Editor | null {
		const leaves = this.app.workspace.getLeavesOfType("markdown");
		for (const leaf of leaves) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === file.path) {
				return view.editor;
			}
		}
		return null;
	}

	private scheduleBackgroundFileSync(file: TFile): void {
		const existingTimer = this.vaultModifyTimers.get(file.path);
		if (existingTimer) {
			clearTimeout(existingTimer);
		}

		const timer = setTimeout(() => {
			this.vaultModifyTimers.delete(file.path);
			void this.syncBackgroundFile(file);
		}, this.settings.autoSyncDebounceMs);

		this.vaultModifyTimers.set(file.path, timer);
	}

	private async syncBackgroundFile(file: TFile): Promise<void> {
		// If opened in an editor since scheduling, delegate to the editor pipeline
		const activeEditor = this.findEditorForFile(file);
		if (activeEditor) {
			await this.syncEditorTasks(activeEditor, file, { notifyUser: false });
			return;
		}

		const content = await this.app.vault.read(file);
		const lines = content.split(/\r?\n/);
		const defaultCategory = this.settings.defaultCategory.trim() || DEFAULT_CATEGORY;
		const syncedIds = new Map<string, string>();

		for (let i = 0; i < lines.length; i++) {
			const parsed = parseTaskLine(lines[i], i, defaultCategory);
			if (!parsed) continue;

			const inFlightKey = `${file.path}::${parsed.originalLine.trim()}`;
			if (this.inFlightTaskKeys.has(inFlightKey)) continue;

			this.inFlightTaskKeys.add(inFlightKey);
			try {
				const created = await this.tasksApi.syncParsedTask(parsed);
				syncedIds.set(parsed.originalLine, created.id);
			} catch (err) {
				console.error("[obsidian-gtasks] Background file sync error:", err);
			} finally {
				this.inFlightTaskKeys.delete(inFlightKey);
			}
		}

		if (syncedIds.size === 0) {
			return;
		}

		this.isApplyingSyncFootprint = true;
		try {
			await this.app.vault.process(file, (currentData) => {
				return currentData
					.split(/\r?\n/)
					.map((line) => {
						const taskId = syncedIds.get(line);
						if (taskId && !hasSyncFootprint(line)) {
							return `${line.replace(/\s+$/, "")} ${formatSyncFootprint(taskId)}`;
						}
						return line;
					})
					.join("\n");
			});
		} finally {
			this.isApplyingSyncFootprint = false;
		}
	}
}

class GTasksSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: ObsidianGTasksPlugin) {
		super(app, plugin);
	}

	public display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Google Tasks Sync Settings" });

		const redirectInfo = containerEl.createEl("p", {
			text: `Configure a Google Cloud OAuth 2.0 Desktop client. If using a Web/Custom redirect client, register the loopback redirect URI: `,
		});
		redirectInfo.createEl("code", { text: REDIRECT_URI });

		new Setting(containerEl)
			.setName("Google OAuth Client ID")
			.setDesc("OAuth 2.0 Client ID from Google Cloud Console (Google Tasks API enabled).")
			.addText((text) =>
				text
					.setPlaceholder("xxxx.apps.googleusercontent.com")
					.setValue(this.plugin.settings.clientId)
					.onChange(async (value) => {
						this.plugin.settings.clientId = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Google OAuth Client Secret")
			.setDesc("OAuth 2.0 Client Secret from Google Cloud Console.")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("GOCSPX-...")
					.setValue(this.plugin.settings.clientSecret)
					.onChange(async (value) => {
						this.plugin.settings.clientSecret = value.trim();
						await this.plugin.saveSettings();
					});
			});

		const isAuthenticated = this.plugin.authManager.isAuthenticated();
		new Setting(containerEl)
			.setName("Google Account Authentication")
			.setDesc(
				isAuthenticated
					? "Connected to Google Tasks (OAuth tokens stored)."
					: "Not authenticated. Click 'Authenticate' to launch the browser OAuth flow."
			)
			.addButton((button) =>
				button
					.setButtonText(isAuthenticated ? "Re-authenticate" : "Authenticate")
					.setCta()
					.onClick(async () => {
						try {
							button.setDisabled(true);
							button.setButtonText("Waiting for browser...");
							await this.plugin.loadSettings();
							await this.plugin.authManager.startOAuthFlow();
							this.plugin.tasksApi.clearCache();
							new Notice("Successfully authenticated with Google Tasks!");
							this.display();
						} catch (err) {
							const msg = err instanceof Error ? err.message : String(err);
							new Notice(`Authentication failed: ${msg}`);
							this.display();
						}
					})
			)
			.addButton((button) => {
				button
					.setButtonText("Disconnect")
					.setDisabled(!isAuthenticated)
					.onClick(async () => {
						await this.plugin.authManager.revokeAndClearTokens();
						this.plugin.tasksApi.clearCache();
						new Notice("Disconnected from Google Tasks.");
						this.display();
					});
			});

		new Setting(containerEl)
			.setName("Default category (TaskList)")
			.setDesc("Default Google Tasks list title when no #<category> tag is specified.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_CATEGORY)
					.setValue(this.plugin.settings.defaultCategory)
					.onChange(async (value) => {
						this.plugin.settings.defaultCategory = value.trim() || DEFAULT_CATEGORY;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Automatic background sync")
			.setDesc(
				"Automatically scan and sync newly written, unsynced #task lines after typing pauses."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoSync).onChange(async (value) => {
					this.plugin.settings.autoSync = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Auto-sync debounce delay (ms)")
			.setDesc("Milliseconds to wait after typing stops before syncing new #task lines.")
			.addText((text) =>
				text
					.setPlaceholder("2000")
					.setValue(String(this.plugin.settings.autoSyncDebounceMs))
					.onChange(async (value) => {
						const parsed = parseInt(value, 10);
						if (!isNaN(parsed) && parsed >= 300) {
							this.plugin.settings.autoSyncDebounceMs = parsed;
							await this.plugin.saveSettings();
							this.plugin.configureDebouncedSync();
						}
					})
			);
	}
}
