import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyGhInvocation } from "../classify.ts";
import type { GhClassification, GhInvocation } from "../types.ts";

function invocation(
	argv: string[],
	assignments: string[] = [],
): GhInvocation {
	return { assignments, argv };
}

function classify(
	argv: string[],
	assignments: string[] = [],
): GhClassification {
	return classifyGhInvocation(invocation(argv, assignments));
}

function assertReadOnly(
	argv: string[],
	normalizedCommand: string,
): void {
	const result = classify(argv);

	assert.equal(result.kind, "readOnly");
	assert.equal(result.normalizedCommand, normalizedCommand);
	assert.deepEqual(result.signatureInput, { assignments: [], argv });
}

function assertWrite(
	name: string,
	argv: string[],
	writeClass: string,
	normalizedCommand: string,
): GhClassification & { kind: "write" } {
	const result = classify(argv);

	assert.equal(result.kind, "write", name);
	assert.equal(result.writeClass, writeClass, name);
	assert.equal(result.normalizedCommand, normalizedCommand, name);
	assert.deepEqual(
		result.signatureInput,
		{ assignments: [], argv },
		name,
	);
	return result;
}

function assertUnsupportedWrite(
	argv: string[],
	writeClass: string,
	reasonIncludes: RegExp,
): void {
	const result = classify(argv);

	assert.equal(result.kind, "unsupportedWrite");
	assert.equal(result.writeClass, writeClass);
	assert.match(result.reason, reasonIncludes);
}

function assertAdvice(
	result: Pick<GhClassification, "validationAdvice">,
	pattern: RegExp,
): void {
	assert.match(result.validationAdvice.join("\n"), pattern);
}

test("classifies read-only issue and pull request commands", () => {
	assertReadOnly(
		["gh", "issue", "view", "1", "-R", "o/r"],
		"gh issue view 1 -R o/r",
	);
	assertReadOnly(
		["gh", "pr", "diff", "2", "-R", "o/r"],
		"gh pr diff 2 -R o/r",
	);
});

test("classifies issue, pull request, release, repo, label, workflow, secret, and variable writes", () => {
	const cases = [
		{
			name: "issue comment",
			argv: [
				"gh",
				"issue",
				"comment",
				"1",
				"-R",
				"o/r",
				"--body-file",
				"body.md",
			],
			writeClass: "issue.comment",
			normalizedCommand:
				"gh issue comment 1 -R o/r --body-file body.md",
		},
		{
			name: "issue edit",
			argv: [
				"gh",
				"issue",
				"edit",
				"1",
				"-R",
				"o/r",
				"--add-label",
				"bug",
			],
			writeClass: "issue.edit",
			normalizedCommand: "gh issue edit 1 -R o/r --add-label bug",
		},
		{
			name: "pr create",
			argv: [
				"gh",
				"pr",
				"create",
				"-R",
				"o/r",
				"--head",
				"branch",
				"--base",
				"main",
				"--title",
				"t",
				"--body-file",
				"body.md",
			],
			writeClass: "pr.create",
			normalizedCommand:
				"gh pr create -R o/r --head branch --base main --title t --body-file body.md",
		},
		{
			name: "pr close",
			argv: ["gh", "pr", "close", "2", "-R", "o/r"],
			writeClass: "pr.close",
			normalizedCommand: "gh pr close 2 -R o/r",
		},
		{
			name: "pr review",
			argv: ["gh", "pr", "review", "2", "-R", "o/r", "--approve"],
			writeClass: "pr.review",
			normalizedCommand: "gh pr review 2 -R o/r --approve",
		},
		{
			name: "pr merge",
			argv: [
				"gh",
				"pr",
				"merge",
				"2",
				"-R",
				"o/r",
				"--match-head-commit",
				"abc",
				"--merge",
			],
			writeClass: "pr.merge",
			normalizedCommand:
				"gh pr merge 2 -R o/r --match-head-commit abc --merge",
		},
		{
			name: "release create",
			argv: [
				"gh",
				"release",
				"create",
				"v1.0",
				"-R",
				"o/r",
				"--notes-file",
				"notes.md",
				"--verify-tag",
			],
			writeClass: "release.create",
			normalizedCommand:
				"gh release create v1.0 -R o/r --notes-file notes.md --verify-tag",
		},
		{
			name: "repo edit",
			argv: ["gh", "repo", "edit", "o/r", "--description", "x"],
			writeClass: "repo.edit",
			normalizedCommand: "gh repo edit o/r --description x",
		},
		{
			name: "label create",
			argv: [
				"gh",
				"label",
				"create",
				"bug",
				"-R",
				"o/r",
				"--color",
				"ff0000",
			],
			writeClass: "label.create",
			normalizedCommand: "gh label create bug -R o/r --color ff0000",
		},
		{
			name: "workflow run",
			argv: ["gh", "workflow", "run", "ci.yml", "-R", "o/r"],
			writeClass: "workflow.run",
			normalizedCommand: "gh workflow run ci.yml -R o/r",
		},
		{
			name: "secret set",
			argv: [
				"gh",
				"secret",
				"set",
				"NAME",
				"-R",
				"o/r",
				"--body",
				"value",
			],
			writeClass: "secret.set",
			normalizedCommand: "gh secret set NAME -R o/r --body value",
		},
		{
			name: "variable set",
			argv: [
				"gh",
				"variable",
				"set",
				"NAME",
				"-R",
				"o/r",
				"--body",
				"value",
			],
			writeClass: "variable.set",
			normalizedCommand: "gh variable set NAME -R o/r --body value",
		},
	] as const;

	for (const item of cases) {
		assertWrite(
			item.name,
			[...item.argv],
			item.writeClass,
			item.normalizedCommand,
		);
	}
});

test("seeds validation advice for pr create, pr merge, and release create", () => {
	const prCreate = assertWrite(
		"pr create",
		[
			"gh",
			"pr",
			"create",
			"-R",
			"o/r",
			"--head",
			"branch",
			"--base",
			"main",
			"--title",
			"t",
			"--body-file",
			"body.md",
		],
		"pr.create",
		"gh pr create -R o/r --head branch --base main --title t --body-file body.md",
	);
	const prMerge = assertWrite(
		"pr merge",
		["gh", "pr", "merge", "2", "-R", "o/r", "--merge"],
		"pr.merge",
		"gh pr merge 2 -R o/r --merge",
	);
	const releaseCreate = assertWrite(
		"release create",
		[
			"gh",
			"release",
			"create",
			"v1.0",
			"-R",
			"o/r",
			"--notes-file",
			"notes.md",
		],
		"release.create",
		"gh release create v1.0 -R o/r --notes-file notes.md",
	);

	assertAdvice(prCreate, /dry-run.*may still push/i);
	assertAdvice(prMerge, /--match-head-commit/i);
	assertAdvice(releaseCreate, /--verify-tag/i);
});

test("detects gh api writes from explicit methods and field-implied post bodies", () => {
	const explicitPost = assertWrite(
		"api post",
		[
			"gh",
			"api",
			"repos/o/r/issues",
			"-X",
			"POST",
			"--input",
			"payload.json",
		],
		"api.post",
		"gh api repos/o/r/issues -X POST --input payload.json",
	);
	const impliedPost = assertWrite(
		"api fields",
		["gh", "api", "repos/o/r/issues", "-f", "title=x"],
		"api.post",
		"gh api repos/o/r/issues -f title=x",
	);

	assert.deepEqual(explicitPost.targetHints, [
		{ source: "restPath", repo: "o/r" },
	]);
	assertAdvice(explicitPost, /--input file\.json/i);
	assertAdvice(impliedPost, /--input file\.json/i);
});

test("detects GraphQL mutations as unsupported repo-less api writes", () => {
	const result = classify([
		"gh",
		"api",
		"graphql",
		"-f",
		"query=mutation { createIssue(input: {}) { clientMutationId } }",
	]);

	assert.equal(result.kind, "unsupportedWrite");
	assert.equal(result.writeClass, "api.graphql.mutation");
	assert.match(result.reason, /repo-less/i);
	assert.equal(
		result.normalizedCommand,
		"gh api graphql -f 'query=mutation { createIssue(input: {}) { clientMutationId } }'",
	);
	assertAdvice(result, /--input file\.json/i);
});

test("marks unsupported public-external write classes explicitly", () => {
	assertUnsupportedWrite(
		["gh", "repo", "create", "o/new", "--public"],
		"repo.create",
		/not-yet-existing repo/i,
	);
	assertUnsupportedWrite(
		["gh", "gist", "create", "file.txt", "--public"],
		"gist.create",
		/gist/i,
	);
	assertUnsupportedWrite(
		["gh", "api", "/user/following/foo", "-X", "PUT"],
		"api.put",
		/non-repo-scoped/i,
	);
});

test("fails closed for unknown possible writes", () => {
	const result = classify(["gh", "foo", "mutate", "-R", "o/r"]);

	assert.equal(result.kind, "ambiguous");
	assert.match(result.reason, /unknown gh command/i);
	assert.match(result.guidance, /manual review/i);
});

test("normalizes leading assignments and quoted literal argv for stable fingerprints", () => {
	const argv = [
		"gh",
		"pr",
		"create",
		"--title",
		"hello world",
		"--body-file",
		".tmp/body.md",
	];
	const result = classify(argv, ["GH_REPO=o/r"]);

	assert.equal(result.kind, "write");
	assert.equal(
		result.normalizedCommand,
		"GH_REPO=o/r gh pr create --title 'hello world' --body-file .tmp/body.md",
	);
	assert.deepEqual(result.signatureInput, {
		assignments: ["GH_REPO=o/r"],
		argv,
	});
	assert.deepEqual(result.targetHints, [
		{ source: "ghRepoAssignment", repo: "o/r" },
	]);
});
