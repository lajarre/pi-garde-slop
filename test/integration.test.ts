import assert from "node:assert/strict";
import { test } from "node:test";
import type { RepoMetadata } from "../extensions/github-write-approval/types.ts";
import { bashToolCall, createHarness } from "./support/harness.ts";

function metadata(
	nameWithOwner: string,
	overrides: Partial<RepoMetadata> = {},
): RepoMetadata {
	return {
		isFork: false,
		isPrivate: false,
		nameWithOwner,
		parent: null,
		viewerPermission: "WRITE",
		visibility: "PUBLIC",
		...overrides,
	};
}

function fakeExec(metadataByRepo: Record<string, RepoMetadata>) {
	return async (command: string, args: string[]) => {
		if (command === "gh" && args[0] === "repo" && args[1] === "view") {
			const repo = args[2] ?? "";
			const repoMetadata = metadataByRepo[repo];
			return repoMetadata
				? {
						exitCode: 0,
						stderr: "",
						stdout: `${JSON.stringify(repoMetadata)}\n`,
					}
				: {
						exitCode: 1,
						stderr: `missing metadata for ${repo}`,
						stdout: "",
					};
		}

		if (
			command === "git" &&
			args[0] === "remote" &&
			args[1] === "get-url" &&
			args[2] === "origin"
		) {
			return {
				exitCode: 1,
				stderr: "fatal: no such remote",
				stdout: "",
			};
		}

		throw new Error(
			`unexpected exec call: ${command} ${args.join(" ")}`,
		);
	};
}

function ghRepoViewCalls(
	execCalls: readonly { command: string; args: string[] }[],
): Array<{ command: string; args: string[] }> {
	return execCalls.filter(
		(call) =>
			call.command === "gh" &&
			call.args[0] === "repo" &&
			call.args[1] === "view",
	);
}

test("prompts once for two public writes and reuses the exact ordered-batch retry approval", async () => {
	const command =
		"gh issue comment 1 -R o/r --body-file a.md && gh pr review 2 -R o/r --body approved";
	const harness = createHarness({
		confirm: async () => true,
		exec: fakeExec({ "o/r": metadata("o/r") }),
		readFile: async (path) => {
			assert.equal(path, "a.md");
			return "approved public body";
		},
	});

	assert.equal(
		await harness.runToolCall(bashToolCall(command)),
		undefined,
	);
	assert.equal(harness.uiCalls.length, 1);
	assert.match(harness.uiCalls[0]?.title ?? "", /GitHub public write/i);
	assert.match(harness.uiCalls[0]?.body ?? "", /Write count: 2/);
	assert.match(
		harness.uiCalls[0]?.body ?? "",
		/Mutation: issue\.comment/,
	);
	assert.match(harness.uiCalls[0]?.body ?? "", /Mutation: pr\.review/);
	assert.equal(ghRepoViewCalls(harness.execCalls).length, 1);

	assert.equal(
		await harness.runToolCall(bashToolCall(command)),
		undefined,
	);
	assert.equal(harness.uiCalls.length, 1);
	assert.equal(ghRepoViewCalls(harness.execCalls).length, 1);
});

test("passes read-only gh commands through without repo, payload, or UI side effects", async () => {
	const harness = createHarness();

	const result = await harness.runToolCall(
		bashToolCall("gh issue view 1 -R o/r"),
	);

	assert.equal(result, undefined);
	assert.deepEqual(harness.execCalls, []);
	assert.deepEqual(harness.fileReadCalls, []);
	assert.deepEqual(harness.uiCalls, []);
});

test("blocks ambiguous extractor results before metadata, payload, or UI side effects", async () => {
	const harness = createHarness();

	const result = await harness.runToolCall(
		bashToolCall("gh issue comment $(cat number) -R o/r --body x"),
	);

	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /ambiguous/i);
	assert.match(result?.reason ?? "", /rewrite/i);
	assert.deepEqual(harness.execCalls, []);
	assert.deepEqual(harness.fileReadCalls, []);
	assert.deepEqual(harness.uiCalls, []);
});

test("blocks the whole bash call when the UI denies public write approval", async () => {
	const harness = createHarness({
		confirm: async () => false,
		exec: fakeExec({ "o/r": metadata("o/r") }),
		readFile: async () => "public body",
	});

	const result = await harness.runToolCall(
		bashToolCall("gh issue comment 1 -R o/r --body-file a.md"),
	);

	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /denied/i);
	assert.equal(harness.uiCalls.length, 1);
	assert.equal(ghRepoViewCalls(harness.execCalls).length, 1);
});

test("blocks public writes without UI and gives local review guidance", async () => {
	const harness = createHarness({
		exec: fakeExec({ "o/r": metadata("o/r") }),
		hasUI: false,
		readFile: async () => "public body",
	});

	const result = await harness.runToolCall(
		bashToolCall("gh issue comment 1 -R o/r --body-file .tmp/body.md"),
	);

	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /no UI/i);
	assert.match(result?.reason ?? "", /\.tmp\//);
	assert.match(result?.reason ?? "", /--body-file/);
	assert.deepEqual(harness.uiCalls, []);
});

test("reuses repository metadata cache across two writes to the same repo", async () => {
	const harness = createHarness({
		exec: fakeExec({
			"o/private": metadata("o/private", {
				isPrivate: true,
				visibility: "PRIVATE",
			}),
		}),
	});

	assert.equal(
		await harness.runToolCall(
			bashToolCall("gh issue comment 1 -R o/private --body one"),
		),
		undefined,
	);
	assert.equal(
		await harness.runToolCall(
			bashToolCall("gh pr close 2 -R o/private"),
		),
		undefined,
	);

	assert.equal(ghRepoViewCalls(harness.execCalls).length, 1);
	assert.deepEqual(harness.uiCalls, []);
});

test("preflight approval never executes the requested GitHub write command", async () => {
	const harness = createHarness({
		confirm: async () => true,
		exec: fakeExec({ "o/r": metadata("o/r") }),
	});

	assert.equal(
		await harness.runToolCall(
			bashToolCall("gh issue comment 1 -R o/r --body redacted"),
		),
		undefined,
	);

	assert.deepEqual(
		harness.execCalls.map((call) => ({
			args: call.args,
			command: call.command,
		})),
		[
			{
				args: [
					"repo",
					"view",
					"o/r",
					"--json",
					"nameWithOwner,isPrivate,visibility,isFork,parent,viewerPermission",
				],
				command: "gh",
			},
		],
	);
	assert.equal(harness.uiCalls.length, 1);
});
