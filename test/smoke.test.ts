import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "./support/harness.ts";

test("passes through non-gh bash tool calls without side effects", async () => {
	const harness = createHarness();

	const result = await harness.runToolCall({
		toolName: "bash",
		input: { command: "npm test" },
	});

	assert.equal(result, undefined);
	assert.deepEqual(harness.execCalls, []);
});
