import assert from "node:assert/strict";
import { test } from "node:test";
import * as ast from "../ast.ts";
import { bashToolCall } from "./support/harness.ts";

const { extractGhInvocations } = ast;

type ParseBash = (input: string) => unknown;

function setParseBashForTest(
	parser: ParseBash | null | undefined,
): void {
	const seam = (
		ast as typeof ast & {
			setParseBashForTest?: (
				parser: ParseBash | null | undefined,
			) => void;
		}
	).setParseBashForTest;

	if (!seam) {
		assert.fail("setParseBashForTest seam is missing");
	}

	seam(parser);
}

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

test("extracts while condition before body in execution order", () => {
	assertReviewable("while gh issue view 1; do gh pr view 2; done", [
		["gh", "issue", "view", "1"],
		["gh", "pr", "view", "2"],
	]);
});

test("extracts if condition before then and else branches", () => {
	assertReviewable(
		"if gh issue view 1; then gh pr view 2; else gh release view v1; fi",
		[
			["gh", "issue", "view", "1"],
			["gh", "pr", "view", "2"],
			["gh", "release", "view", "v1"],
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

test("blocks gh hidden inside arithmetic expansion substitution", () => {
	assertAmbiguous(
		"echo $(( $(gh issue comment 1 --body x) + 1 ))",
		"arithmetic expansion",
	);
});

test("blocks escaped gh inside arithmetic expansion substitution", () => {
	assertAmbiguous(
		"echo $(( $(g\\h issue comment 1 --body x) + 1 ))",
		"arithmetic expansion",
	);
});

test("blocks gh hidden inside parameter expansion substitution", () => {
	const command =
		"echo " + "$" + "{x:-" + "$" + "(gh issue comment 1 --body x)}";

	assertAmbiguous(command, "parameter expansion");
});

test("blocks quoted gh inside parameter expansion substitution", () => {
	const command =
		"echo " + "$" + "{x:-" + "$" + "(g''h issue comment 1 --body x)}";

	assertAmbiguous(command, "parameter expansion");
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

test("blocks shell -c after value-taking shell options", () => {
	for (const command of [
		"bash -O extglob -c 'gh issue comment 1 --body x'",
		"bash -o pipefail -c 'gh issue comment 1 --body x'",
		"sh -o pipefail -c 'gh issue comment 1 --body x'",
		"zsh -o pipefail -c 'gh issue comment 1 --body x'",
		"zsh --emulate sh -c 'gh issue comment 1 --body x'",
	]) {
		assertAmbiguous(command, "shell");
	}
});

test("returns no invocations for shell executables without command strings", () => {
	for (const command of ["bash --version", "zsh --version"]) {
		assertReviewable(command, []);
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

test("blocks env state-mutating options", () => {
	for (const command of [
		"GH_REPO=o/private env -i gh issue comment 1 --body x",
		"GH_REPO=o/private env -u GH_REPO gh issue comment 1 --body x",
		"env --chdir ../other gh issue comment 1 --body x",
	]) {
		assertAmbiguous(command, "env");
	}
});

test("blocks heredoc stdin attached to gh", () => {
	assertAmbiguous(
		"gh issue comment 1 --body-file - <<EOF\nbody\nEOF",
		"heredoc",
	);
});

test("blocks opaque stdin inherited by grouped gh commands", () => {
	assertAmbiguous("{ gh issue view 1; } < payload.txt", "stdin");
});

test("blocks heredoc stdin inherited by grouped gh commands", () => {
	assertAmbiguous(
		"{ gh issue view 1; } <<'EOF'\nbody\nEOF",
		"heredoc|stdin",
	);
});

test("blocks shell executables that read scripts from heredoc stdin", () => {
	assertAmbiguous(
		"bash <<'EOF'\ngh issue view 1\nEOF",
		"shell|heredoc|stdin",
	);
});

test("blocks shell executables that read scripts from pipeline stdin", () => {
	assertAmbiguous(
		"printf 'gh issue view 1\\n' | bash",
		"shell|pipeline|stdin",
	);
});

test("blocks parser failures when gh is present", () => {
	assertAmbiguous("gh issue comment 1 --body 'unterminated", "parse");
});

test("blocks parser unavailable for literal-hidden gh command words", () => {
	setParseBashForTest(null);
	try {
		for (const command of [
			"g''h issue comment 1 --body x",
			'g""h issue comment 1 --body x',
			"g\\h issue comment 1 --body x",
			"g\\\nh issue comment 1 --body x",
		]) {
			assertAmbiguous(command, "parser unavailable");
		}
	} finally {
		setParseBashForTest(undefined);
	}
});

test("blocks parser unavailable for dynamic words that may hide gh", () => {
	setParseBashForTest(null);
	try {
		for (const command of ["g{h,} issue view 1", "g[h] issue view 1"]) {
			assertAmbiguous(command, "parser unavailable");
		}
	} finally {
		setParseBashForTest(undefined);
	}
});

test("blocks parser unavailable for shell scripts from opaque stdin", () => {
	setParseBashForTest(null);
	try {
		for (const command of [
			"bash < payload.txt",
			"cat payload.txt | bash",
			"sh < payload.txt",
			"cat payload.txt | zsh",
			"bash <<'EOF'\necho opaque\nEOF",
		]) {
			assertAmbiguous(command, "parser unavailable");
		}
	} finally {
		setParseBashForTest(undefined);
	}
});

test("blocks parser failures for literal-hidden gh command words", () => {
	setParseBashForTest(() => {
		throw new Error("forced parse failure");
	});
	try {
		for (const command of [
			"g''h issue comment 1 --body x",
			'g""h issue comment 1 --body x',
			"g\\h issue comment 1 --body x",
			"g\\\nh issue comment 1 --body x",
		]) {
			assertAmbiguous(command, "parse");
		}
	} finally {
		setParseBashForTest(undefined);
	}
});

test("blocks parser failures for dynamic words that may hide gh", () => {
	setParseBashForTest(() => {
		throw new Error("forced parse failure");
	});
	try {
		for (const command of ["g{h,} issue view 1", "g[h] issue view 1"]) {
			assertAmbiguous(command, "parse");
		}
	} finally {
		setParseBashForTest(undefined);
	}
});

test("blocks parser failures for shell scripts from opaque stdin", () => {
	setParseBashForTest(() => {
		throw new Error("forced parse failure");
	});
	try {
		for (const command of [
			"bash < payload.txt",
			"cat payload.txt | bash",
			"zsh <&3",
			"printf '%s\\n' payload | sh",
			"bash <<< 'echo opaque'",
		]) {
			assertAmbiguous(command, "parse");
		}
	} finally {
		setParseBashForTest(undefined);
	}
});

test("does not treat command query modes as gh execution", () => {
	for (const command of ["command -v gh", "command -V gh"]) {
		assertReviewable(command, []);
	}
});

test("blocks parser failures for standalone dot source", () => {
	setParseBashForTest(() => {
		throw new Error("forced parse failure");
	});
	try {
		assertAmbiguous(". ./script", "parse");
	} finally {
		setParseBashForTest(undefined);
	}
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
