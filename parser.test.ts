import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
	appendSyncFootprint,
	extractSyncId,
	hasSyncFootprint,
	parseTaskLine,
	parseTasksFromContent,
} from "./parser";

describe("parser", () => {
	it("parses standard task with #task, #<category>, and #YYYY-MM-DD", () => {
		const line = "- [ ] #task #HOY Clean garage #2026-11-15";
		const parsed = parseTaskLine(line, 4);

		assert.deepEqual(parsed, {
			lineNumber: 4,
			originalLine: line,
			title: "Clean garage",
			category: "HOY",
			due: "2026-11-15T00:00:00.000Z",
			rawDate: "2026-11-15",
		});
	});

	it("parses tags in any order and strips them from title", () => {
		const line = "- [ ] Buy groceries #2026-12-01 for dinner #personal #task";
		const parsed = parseTaskLine(line, 0);

		assert.deepEqual(parsed, {
			lineNumber: 0,
			originalLine: line,
			title: "Buy groceries for dinner",
			category: "personal",
			due: "2026-12-01T00:00:00.000Z",
			rawDate: "2026-12-01",
		});
	});

	it("defaults category to HOY when #<category> is omitted", () => {
		const line = "- [ ] #task Finish quarterly report #2026-11-20";
		const parsed = parseTaskLine(line, 1);

		assert.deepEqual(parsed, {
			lineNumber: 1,
			originalLine: line,
			title: "Finish quarterly report",
			category: "HOY",
			due: "2026-11-20T00:00:00.000Z",
			rawDate: "2026-11-20",
		});
	});

	it("omits due when no #YYYY-MM-DD tag is present", () => {
		const line = "  - [ ] #work Review PRs #task";
		const parsed = parseTaskLine(line, 2);

		assert.deepEqual(parsed, {
			lineNumber: 2,
			originalLine: line,
			title: "Review PRs",
			category: "work",
		});
	});

	it("ignores lines that already have a %%gtask:...%% footprint", () => {
		const line = "- [ ] #task #HOY Clean garage #2026-11-15 %%gtask:abc123xyz%%";
		assert.equal(hasSyncFootprint(line), true);
		assert.equal(extractSyncId(line), "abc123xyz");
		assert.equal(parseTaskLine(line, 0), null);
	});

	it("ignores checked tasks and lines without #task", () => {
		assert.equal(parseTaskLine("- [x] #task #HOY Done item", 0), null);
		assert.equal(parseTaskLine("- [ ] #HOY Missing task anchor", 0), null);
		assert.equal(parseTaskLine("Just a paragraph with #task", 0), null);
		assert.equal(parseTaskLine("- [ ] #task #HOY", 0), null);
	});

	it("appends %%gtask:<TASK_ID>%% idempotently", () => {
		const raw = "- [ ] #task #HOY Clean garage #2026-11-15   ";
		const synced = appendSyncFootprint(raw, "task_999");
		assert.equal(synced, "- [ ] #task #HOY Clean garage #2026-11-15 %%gtask:task_999%%");
		assert.equal(appendSyncFootprint(synced, "other_id"), synced);
	});

	it("parses multiple tasks from document content", () => {
		const doc = [
			"# Daily Notes",
			"- [ ] #task #HOY Clean garage #2026-11-15 %%gtask:existing123%%",
			"- [ ] #task Call dentist #salud #2026-11-18",
			"- [x] #task Already completed",
			"- [ ] Prepare slides #task",
		].join("\n");

		const tasks = parseTasksFromContent(doc);
		assert.equal(tasks.length, 2);
		assert.equal(tasks[0].title, "Call dentist");
		assert.equal(tasks[0].category, "salud");
		assert.equal(tasks[0].lineNumber, 2);
		assert.equal(tasks[1].title, "Prepare slides");
		assert.equal(tasks[1].category, "HOY");
		assert.equal(tasks[1].lineNumber, 4);
	});
});
