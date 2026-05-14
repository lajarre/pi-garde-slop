import assert from "node:assert/strict";
import { test } from "node:test";
import { extractGhInvocations } from "../ast.ts";
import { bashToolCall } from "./support/harness.ts";

function assertReviewable(
	command: string,
	expectedArgv: string[][],
): void {
	const result = extractGhInvocations(command);

	assert.equal(result.kind, "reviewable");
	assert.deepEqual(
		result.invocations.map((invocation) => invocation.argv),
		expectedArgv,
	);
}

function assertAmbiguous(
	command: string,
	reasonIncludes: string,
): void {
	const result = extractGhInvocations(command);

	assert.equal(result.kind, "ambiguous");
	assert.match(result.reason, new RegExp(reasonIncludes, "i"));
	assert.match(result.guidance, /rewrite as literal `gh \.\.\./i);
}

test("extracts a single literal gh invocation", () => {
	const event = bashToolCall(
		"gh issue comment 1 --body-file .tmp/body.md",
	);

	assertReviewable(String(event.input.command), [
		["gh", "issue", "comment", "1", "--body-file", ".tmp/body.md"],
	]);
});

test("extracts multiple gh invocations joined by && in execution order", () => {
	assertReviewable(
		"gh issue comment 1 --body-file a.md && gh pr review 2 --approve",
		[
			["gh", "issue", "comment", "1", "--body-file", "a.md"],
			["gh", "pr", "review", "2", "--approve"],
		],
	);
});

test("extracts multiple gh invocations joined by ; in execution order", () => {
	assertReviewable(
		"gh issue edit 1 --add-label bug; gh pr comment 2 --body-file b.md",
		[
			["gh", "issue", "edit", "1", "--add-label", "bug"],
			["gh", "pr", "comment", "2", "--body-file", "b.md"],
		],
	);
});

test("returns no invocations for non-gh bash", () => {
	const result = extractGhInvocations("npm test");

	assert.equal(result.kind, "reviewable");
	assert.deepEqual(result.invocations, []);
});

test("blocks a dynamic command word that may hide gh", () => {
	assertAmbiguous("$cmd issue comment 1 --body x", "dynamic command");
});

test("blocks a dynamic gh subcommand", () => {
	assertAmbiguous(
		'gh "$kind" comment 1 --body x',
		"dynamic subcommand",
	);
});

test("blocks command substitution in gh args", () => {
	assertAmbiguous(
		"gh issue comment $(cat n) --body x",
		"command substitution",
	);
});

test("blocks gh api opaque stdin payloads", () => {
	assertAmbiguous(
		"gh api repos/o/r/issues -X POST --input -",
		"opaque stdin",
	);
});

test("blocks editor-backed gh issue create", () => {
	assertAmbiguous("gh issue create --editor", "--editor");
});

test("blocks browser-backed gh pr create", () => {
	assertAmbiguous("gh pr create --web", "--web");
});

test("blocks shell functions named gh", () => {
	assertAmbiguous(
		"function gh() { echo nope; }; gh issue view 1",
		"function",
	);
});

test("blocks shell functions that hide gh behind another name", () => {
	assertAmbiguous(
		"foo() { gh issue comment 1 --body x; }; foo",
		"function",
	);
});

test("blocks alias-style gh setup", () => {
	assertAmbiguous("alias gh=echo; gh issue view 1", "alias");
});

test("blocks alias setup that hides gh behind another name", () => {
	assertAmbiguous(
		'alias foo="gh issue comment 1 --body x"; foo',
		"alias",
	);
});

test("blocks eval strings that can hide gh", () => {
	assertAmbiguous("eval 'gh issue comment 1 --body x'", "eval");
});

test("blocks source commands that can hide gh in external files", () => {
	assertAmbiguous("source ./script", "source");
});

test("blocks dot commands that can hide gh in external files", () => {
	assertAmbiguous(". ./script", "source");
});

test("blocks shell -c commands that can hide gh", () => {
	for (const shell of ["bash", "sh", "zsh"]) {
		assertAmbiguous(
			`${shell} -c 'gh issue comment 1 --body x'`,
			"shell",
		);
	}
});

test("blocks alias setup after literal wrapper resolution", () => {
	for (const command of [
		'command alias foo="gh issue comment 1 --body x"; foo',
		'builtin alias foo="gh issue comment 1 --body x"; foo',
	]) {
		assertAmbiguous(command, "alias");
	}
});

test("blocks env split-string forms that can hide gh", () => {
	for (const command of [
		'env -S "gh issue comment 1 --body x"',
		'env --split-string="gh issue comment 1 --body x"',
	]) {
		assertAmbiguous(command, "split-string");
	}
});

test("blocks heredoc stdin attached to gh", () => {
	assertAmbiguous(
		"gh issue comment 1 --body-file - <<EOF\nbody\nEOF",
		"heredoc",
	);
});

test("blocks parser failures when gh is present", () => {
	assertAmbiguous("gh issue comment 1 --body 'unterminated", "parse");
});

test("keeps leading assignments and unwraps literal simple wrappers", () => {
	const result = extractGhInvocations(
		"GH_REPO=o/r env NO_COLOR=1 command gh issue view 1",
	);

	assert.equal(result.kind, "reviewable");
	assert.deepEqual(result.invocations, [
		{
			assignments: ["GH_REPO=o/r", "NO_COLOR=1"],
			argv: ["gh", "issue", "view", "1"],
		},
	]);
});
