import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildApprovalSignature,
	createApprovalSignatureStore,
} from "../extensions/github-write-approval/approval.ts";
import { extractGhInvocations } from "../extensions/github-write-approval/ast.ts";
import { classifyGhInvocation } from "../extensions/github-write-approval/classify.ts";
import { resolvePayloadIdentity } from "../extensions/github-write-approval/payload.ts";
import { evaluateBatchPolicy } from "../extensions/github-write-approval/policy.ts";
import {
	createRepoMetadataCache,
	REPO_METADATA_JSON_FIELDS,
	type RepoExec,
	resolveRepoForGhWrite,
} from "../extensions/github-write-approval/repo.ts";
import type {
	ApprovalSignature,
	ApprovalWriteInput,
	GhClassification,
	GhInvocation,
	GhWriteClass,
	PayloadIdentity,
	PolicyEvaluationInput,
	RepoMetadata,
	RepoResolutionResult,
	ResolvedRepoTarget,
} from "../extensions/github-write-approval/types.ts";
import { bashToolCall, createHarness } from "./support/harness.ts";

type Fixture<Id extends string = string> = {
	id: Id;
	run: () => Promise<void> | void;
};

type ExecCall = {
	args: string[];
	command: string;
	options?: { cwd?: string; timeout?: number };
};

const REQUIRED_AST_IDS = [
	"single gh",
	"executor wrappers",
	"command executors",
	"multiple gh with &&",
	"multiple gh with ;",
	"non-gh bash",
	"dynamic command word",
	"dynamic subcommand",
	"command substitution in args",
	"opaque stdin payload",
	"editor/web prompt",
] as const;
const REQUIRED_CLASSIFICATION_IDS = [
	"read-only issue",
	"read-only PR diff",
	"issue comment",
	"host-qualified repo target",
	"host override",
	"issue edit",
	"PR create",
	"PR close",
	"PR review",
	"PR merge",
	"release create",
	"repo edit",
	"label create",
	"workflow run",
	"secret set",
	"org scoped secret set",
	"user scoped secret set",
	"variable set",
	"org scoped variable set",
	"user scoped variable set",
	"REST API POST",
	"REST API fields imply POST",
	"GraphQL mutation",
	"unknown possible write",
] as const;
const REQUIRED_REPO_IDS = [
	"short repo flag",
	"long repo flag",
	"positional repo target",
	"REST path repo target",
	"explicit target overrides cwd",
	"REST path target overrides cwd",
	"GH_REPO env",
	"conflicting explicit targets",
	"cwd remote",
	"unresolved repo",
	"metadata cache",
	"same basename different owner",
	"different repos",
] as const;
const REQUIRED_VISIBILITY_IDS = [
	"private issue comment",
	"public issue comment",
	"public PR review",
	"public PR close",
	"fork with public parent",
	"admin on public repo",
	"non-repo-scoped repo create",
	"gist write",
	"repo-less API mutation",
] as const;
const REQUIRED_APPROVAL_IDS = [
	"exact single retry",
	"changed repo",
	"changed target",
	"changed flags",
	"changed body file path",
	"same body path changed contents",
	"unreadable body file",
	"short body file flag",
	"release asset file",
	"identical ordered batch retry",
	"reordered batch",
	"subset batch",
	"superset batch",
] as const;
const REQUIRED_NO_UI_PROMPT_IDS = [
	"no UI public write",
	"no UI guidance",
	"UI approval prompt",
	"UI denial",
	"UI all-or-none approval",
	"stateful prefix implicit target",
	"file payload shell prefix",
] as const;

function fixture<Id extends string>(
	id: Id,
	run: Fixture<Id>["run"],
): Fixture<Id> {
	return { id, run };
}

function assertExactFixtureIds(
	section: string,
	required: readonly string[],
	fixtures: readonly Fixture[],
): void {
	const implemented = fixtures.map((item) => item.id);
	assert.deepEqual(implemented, [...required], section);
	assert.equal(new Set(implemented).size, implemented.length);
}

function reviewableInvocations(command: string): GhInvocation[] {
	const result = extractGhInvocations(command);
	if (result.kind !== "reviewable") {
		assert.fail(`${command}: ${result.reason}`);
	}
	return result.invocations;
}

function singleInvocation(command: string): GhInvocation {
	const invocations = reviewableInvocations(command);
	assert.equal(invocations.length, 1, command);
	return invocations[0] as GhInvocation;
}

function classifyCommand(command: string): GhClassification {
	return classifyGhInvocation(singleInvocation(command));
}

function writeClassification(
	command: string,
): GhClassification & { kind: "write" } {
	const classification = classifyCommand(command);
	if (classification.kind !== "write") {
		assert.fail(
			`expected write for ${command}; got ${classification.kind}`,
		);
	}
	return classification;
}

function unsupportedClassification(
	command: string,
): GhClassification & { kind: "unsupportedWrite" } {
	const classification = classifyCommand(command);
	if (classification.kind !== "unsupportedWrite") {
		assert.fail(`expected unsupported write for ${command}`);
	}
	return classification;
}

function assertExtracts(
	command: string,
	expectedArgv: readonly (readonly string[])[],
): void {
	assert.deepEqual(
		reviewableInvocations(command).map((item) => item.argv),
		expectedArgv,
	);
}

function assertAmbiguous(command: string, reason: RegExp): void {
	const result = extractGhInvocations(command);
	assert.equal(result.kind, "ambiguous", command);
	assert.match(result.reason, reason, command);
	assert.match(
		result.guidance,
		/rewrite as literal `gh \.\.\./i,
		command,
	);
}

function assertClassification(
	command: string,
	kind: GhClassification["kind"],
	writeClass?: GhWriteClass,
): GhClassification {
	const classification = classifyCommand(command);
	assert.equal(classification.kind, kind, command);
	if (writeClass) {
		assert.equal(
			(classification as { writeClass?: string }).writeClass,
			writeClass,
			command,
		);
	}
	return classification;
}

function metadata(
	nameWithOwner: string,
	overrides: Partial<RepoMetadata> = {},
): RepoMetadata {
	const isPrivate = overrides.isPrivate ?? false;
	return {
		isFork: false,
		isPrivate,
		nameWithOwner,
		parent: null,
		viewerPermission: "WRITE",
		visibility: isPrivate ? "PRIVATE" : "PUBLIC",
		...overrides,
	};
}

function target(repo = "o/r"): ResolvedRepoTarget {
	return { repo, source: "repoFlag" };
}

function resolvedRepo(
	repo: RepoMetadata,
): RepoResolutionResult & { kind: "resolved" } {
	return {
		kind: "resolved",
		metadata: repo,
		target: target(repo.nameWithOwner),
	};
}

function fakeExec(options: {
	metadata?: Record<string, RepoMetadata>;
	remoteUrl?: string | null;
}): { calls: ExecCall[]; exec: RepoExec } {
	const calls: ExecCall[] = [];
	const metadataByRepo = options.metadata ?? {};
	const exec: RepoExec = async (command, args, execOptions) => {
		calls.push({ args: [...args], command, options: execOptions });
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
			return options.remoteUrl
				? { exitCode: 0, stderr: "", stdout: `${options.remoteUrl}\n` }
				: { exitCode: 1, stderr: "fatal: no remote", stdout: "" };
		}
		throw new Error(
			`unexpected exec call: ${command} ${args.join(" ")}`,
		);
	};
	return { calls, exec };
}

function fakeHarnessExec(metadataByRepo: Record<string, RepoMetadata>) {
	return async (command: string, args: string[]) => {
		const { exec } = fakeExec({
			metadata: metadataByRepo,
			remoteUrl: null,
		});
		return await exec(command, args);
	};
}

async function resolveCommand(
	command: string,
	exec = fakeExec({ metadata: { "o/r": metadata("o/r") } }),
	cache = createRepoMetadataCache(),
): Promise<{ calls: ExecCall[]; result: RepoResolutionResult }> {
	const result = await resolveRepoForGhWrite(
		writeClassification(command),
		{
			cache,
			cwd: "/fixture/project",
			exec: exec.exec,
		},
	);
	return { calls: exec.calls, result };
}

function metadataCalls(calls: readonly ExecCall[]): ExecCall[] {
	return calls.filter(
		(call) => call.command === "gh" && call.args[0] === "repo",
	);
}

function gitCalls(calls: readonly ExecCall[]): ExecCall[] {
	return calls.filter((call) => call.command === "git");
}

function assertResolved(
	result: RepoResolutionResult,
	repo: string,
	source: string,
): void {
	assert.equal(result.kind, "resolved");
	assert.equal(result.target.repo, repo);
	assert.equal(result.target.source, source);
	assert.equal(result.metadata.nameWithOwner, repo);
}

function assertOnlyMetadataLookup(
	calls: readonly ExecCall[],
	repo: string,
): void {
	assert.deepEqual(
		calls.map((call) => ({ args: call.args, command: call.command })),
		[
			{
				args: [
					"repo",
					"view",
					repo,
					"--json",
					REPO_METADATA_JSON_FIELDS,
				],
				command: "gh",
			},
		],
	);
}

async function payloadFor(
	classification: GhClassification,
	files: Record<string, string> = {},
): Promise<PayloadIdentity> {
	const result = await resolvePayloadIdentity(classification, {
		readFile: async (path) => {
			if (!(path in files)) {
				throw new Error(`missing fixture file ${path}`);
			}
			return files[path] ?? "";
		},
	});
	if (result.kind !== "resolved") {
		assert.fail(result.reason);
	}
	return result.identity;
}

async function approvalWrite(
	command: string,
	files: Record<string, string> = {},
	repo = "o/r",
): Promise<ApprovalWriteInput> {
	const classification = writeClassification(command);
	return {
		classification,
		payload: await payloadFor(classification, files),
		repo: metadata(repo),
		target: target(repo),
	};
}

async function singleSignature(
	command: string,
	files: Record<string, string> = {},
	repo = "o/r",
): Promise<ApprovalSignature> {
	return buildApprovalSignature([
		await approvalWrite(command, files, repo),
	]);
}

async function policyWrite(
	command: string,
	repo: RepoMetadata,
	files: Record<string, string> = {},
): Promise<PolicyEvaluationInput> {
	const classification = writeClassification(command);
	return {
		classification,
		payload: await payloadFor(classification, files),
		repo,
		repoResolution: resolvedRepo(repo),
		target: target(repo.nameWithOwner),
	};
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function repoCase(
	id: (typeof REQUIRED_REPO_IDS)[number],
	command: string,
	repo: string,
	source: string,
	options: { noGit?: boolean; remoteUrl?: string | null } = {},
): Fixture<(typeof REQUIRED_REPO_IDS)[number]> {
	return fixture(id, async () => {
		const fake = fakeExec({
			metadata: { [repo]: metadata(repo) },
			...options,
		});
		const { calls, result } = await resolveCommand(command, fake);
		assertResolved(result, repo, source);
		if (options.noGit) {
			assert.equal(gitCalls(calls).length, 0);
		}
		assertOnlyMetadataLookup(calls, repo);
	});
}

function classificationCase(
	id: (typeof REQUIRED_CLASSIFICATION_IDS)[number],
	command: string,
	kind: GhClassification["kind"],
	writeClass?: GhWriteClass,
): Fixture<(typeof REQUIRED_CLASSIFICATION_IDS)[number]> {
	return fixture(id, () => {
		assertClassification(command, kind, writeClass);
	});
}

async function promptDecision(input: PolicyEvaluationInput) {
	const decision = evaluateBatchPolicy([input], { hasUI: true });
	assert.equal(decision.kind, "prompt");
	return decision;
}

const astExtractionFixtures = [
	fixture("single gh", () =>
		assertExtracts("gh issue comment 1 --body-file .tmp/body.md", [
			["gh", "issue", "comment", "1", "--body-file", ".tmp/body.md"],
		]),
	),
	fixture("executor wrappers", () => {
		for (const command of [
			"timeout 10 gh issue comment 1 --body x",
			"nice gh issue comment 1 --body x",
			"arch -arm64 gh issue comment 1 --body x",
		]) {
			assertExtracts(command, [
				["gh", "issue", "comment", "1", "--body", "x"],
			]);
		}
	}),
	fixture("command executors", () => {
		for (const command of [
			'printf "1 --body pwn" | xargs gh issue comment',
			"printf 'gh issue comment 1 -R o/r --body x' | xargs -I{} sh -c '{}'",
			"xargs -a cmds.txt -I{} {} issue comment 1 --body x",
			"xargs sh -c 'gh issue comment 1 -R o/r --body x'",
			"parallel gh issue comment ::: 1 --body x",
			"parallel 'gh issue comment 1 -R o/r --body x' ::: a",
			"find . -exec gh issue comment 1 --body x ;",
			"find . -exec sh -c 'gh issue comment 1 -R o/r --body x' ;",
			"sudo gh issue comment 1 --body x",
			"sudo GH_REPO=o/r gh issue comment 1 --body x",
			"sudo -D /tmp gh issue comment 1 --body x",
		]) {
			assertAmbiguous(command, /executor|gh/i);
		}
	}),
	fixture("multiple gh with &&", () =>
		assertExtracts(
			"gh issue comment 1 --body-file a.md && gh pr review 2 --approve",
			[
				["gh", "issue", "comment", "1", "--body-file", "a.md"],
				["gh", "pr", "review", "2", "--approve"],
			],
		),
	),
	fixture("multiple gh with ;", () =>
		assertExtracts(
			"gh issue edit 1 --add-label bug; gh pr comment 2 --body-file b.md",
			[
				["gh", "issue", "edit", "1", "--add-label", "bug"],
				["gh", "pr", "comment", "2", "--body-file", "b.md"],
			],
		),
	),
	fixture("non-gh bash", () =>
		assert.deepEqual(reviewableInvocations("npm test"), []),
	),
	fixture("dynamic command word", () =>
		assertAmbiguous(
			"$cmd issue comment 1 --body x",
			/dynamic command/i,
		),
	),
	fixture("dynamic subcommand", () =>
		assertAmbiguous(
			'gh "$kind" comment 1 --body x',
			/dynamic subcommand/i,
		),
	),
	fixture("command substitution in args", () =>
		assertAmbiguous(
			"gh issue comment $(cat n) --body x",
			/command substitution/i,
		),
	),
	fixture("opaque stdin payload", () =>
		assertAmbiguous(
			"gh api repos/o/r/issues -X POST --input -",
			/opaque stdin/i,
		),
	),
	fixture("editor/web prompt", () => {
		assertAmbiguous("gh issue create --editor", /--editor/i);
		assertAmbiguous("gh pr create --web", /--web/i);
	}),
] satisfies readonly Fixture<(typeof REQUIRED_AST_IDS)[number]>[];

const classificationFixtures = [
	classificationCase(
		"read-only issue",
		"gh issue view 1 -R o/r",
		"readOnly",
	),
	classificationCase(
		"read-only PR diff",
		"gh pr diff 2 -R o/r",
		"readOnly",
	),
	classificationCase(
		"issue comment",
		"gh issue comment 1 -R o/r --body-file body.md",
		"write",
		"issue.comment",
	),
	classificationCase(
		"host-qualified repo target",
		"gh issue comment 1 -R github.com/o/r --body x",
		"ambiguous",
	),
	fixture("host override", () => {
		const classification = classifyGhInvocation({
			assignments: ["GH_HOST=github.example.com"],
			argv: ["gh", "issue", "comment", "1", "-R", "o/r"],
		});
		assert.equal(classification.kind, "ambiguous");
		assert.match(
			(classification as { reason: string }).reason,
			/GH_HOST|hostname/i,
		);
	}),
	classificationCase(
		"issue edit",
		"gh issue edit 1 -R o/r --add-label bug",
		"write",
		"issue.edit",
	),
	classificationCase(
		"PR create",
		"gh pr create -R o/r --head branch --base main --title t --body-file body.md",
		"write",
		"pr.create",
	),
	classificationCase(
		"PR close",
		"gh pr close 2 -R o/r",
		"write",
		"pr.close",
	),
	classificationCase(
		"PR review",
		"gh pr review 2 -R o/r --approve",
		"write",
		"pr.review",
	),
	classificationCase(
		"PR merge",
		"gh pr merge 2 -R o/r --match-head-commit abc --merge",
		"write",
		"pr.merge",
	),
	classificationCase(
		"release create",
		"gh release create v1.0 -R o/r --notes-file notes.md --verify-tag",
		"write",
		"release.create",
	),
	classificationCase(
		"repo edit",
		"gh repo edit o/r --description x",
		"write",
		"repo.edit",
	),
	classificationCase(
		"label create",
		"gh label create bug -R o/r --color ff0000",
		"write",
		"label.create",
	),
	classificationCase(
		"workflow run",
		"gh workflow run ci.yml -R o/r",
		"write",
		"workflow.run",
	),
	classificationCase(
		"secret set",
		"gh secret set NAME -R o/r --body value",
		"write",
		"secret.set",
	),
	classificationCase(
		"org scoped secret set",
		"gh secret set NAME --org myorg --body value",
		"unsupportedWrite",
		"secret.set",
	),
	classificationCase(
		"user scoped secret set",
		"gh secret set NAME --user lajarre --body value",
		"unsupportedWrite",
		"secret.set",
	),
	classificationCase(
		"variable set",
		"gh variable set NAME -R o/r --body value",
		"write",
		"variable.set",
	),
	classificationCase(
		"org scoped variable set",
		"gh variable set NAME --org myorg --body value",
		"unsupportedWrite",
		"variable.set",
	),
	classificationCase(
		"user scoped variable set",
		"gh variable set NAME --user lajarre --body value",
		"unsupportedWrite",
		"variable.set",
	),
	classificationCase(
		"REST API POST",
		"gh api repos/o/r/issues -X POST --input payload.json",
		"write",
		"api.post",
	),
	classificationCase(
		"REST API fields imply POST",
		"gh api repos/o/r/issues -f title=x",
		"write",
		"api.post",
	),
	classificationCase(
		"GraphQL mutation",
		"gh api graphql -f 'query=mutation { createIssue(input: {}) { id } }'",
		"unsupportedWrite",
		"api.graphql.mutation",
	),
	classificationCase(
		"unknown possible write",
		"gh foo mutate -R o/r",
		"ambiguous",
	),
] satisfies readonly Fixture<
	(typeof REQUIRED_CLASSIFICATION_IDS)[number]
>[];

const repoResolutionFixtures = [
	repoCase(
		"short repo flag",
		"gh issue comment 1 -R o/r --body x",
		"o/r",
		"repoFlag",
	),
	repoCase(
		"long repo flag",
		"gh issue comment 1 --repo o/r --body x",
		"o/r",
		"repoFlag",
	),
	repoCase(
		"positional repo target",
		"gh repo edit o/r --description x",
		"o/r",
		"positionalRepo",
	),
	repoCase(
		"REST path repo target",
		"gh api repos/o/r/issues -X POST --input payload.json",
		"o/r",
		"restPath",
	),
	repoCase(
		"explicit target overrides cwd",
		"gh repo edit o/r --description x",
		"o/r",
		"positionalRepo",
		{
			noGit: true,
			remoteUrl: "https://github.com/other/default.git",
		},
	),
	repoCase(
		"REST path target overrides cwd",
		"gh api repos/o/r/issues -X POST --input payload.json",
		"o/r",
		"restPath",
		{ noGit: true, remoteUrl: "git@github.com:other/default.git" },
	),
	repoCase(
		"GH_REPO env",
		"GH_REPO=o/r gh issue comment 1 --body x",
		"o/r",
		"ghRepoAssignment",
	),
	fixture("conflicting explicit targets", async () => {
		const fake = fakeExec({
			metadata: { "o/r1": metadata("o/r1"), "o/r2": metadata("o/r2") },
		});
		const { calls, result } = await resolveCommand(
			"GH_REPO=o/r1 gh api repos/o/r2/issues -X POST --input payload.json",
			fake,
		);
		assert.equal(result.kind, "conflict");
		assert.match(result.reason, /conflicting explicit repo targets/i);
		assert.deepEqual(calls, []);
	}),
	fixture("cwd remote", async () => {
		const fake = fakeExec({
			metadata: { "o/r": metadata("o/r") },
			remoteUrl: "https://github.com/o/r.git",
		});
		const { calls, result } = await resolveCommand(
			"gh issue comment 1 --body x",
			fake,
		);
		assertResolved(result, "o/r", "cwdRemote");
		assert.equal(gitCalls(calls).length, 1);
		assert.deepEqual(
			metadataCalls(calls).map((call) => call.args[2]),
			["o/r"],
		);
	}),
	fixture("unresolved repo", async () => {
		const fake = fakeExec({ remoteUrl: null });
		const { calls, result } = await resolveCommand(
			"gh issue comment 1 --body x",
			fake,
		);
		assert.equal(result.kind, "unresolved");
		assert.match(result.guidance, /-R owner\/repo/i);
		assert.equal(gitCalls(calls).length, 1);
		assert.equal(metadataCalls(calls).length, 0);
	}),
	fixture("metadata cache", async () => {
		const fake = fakeExec({ metadata: { "o/r": metadata("o/r") } });
		const cache = createRepoMetadataCache();
		await resolveCommand(
			"gh issue comment 1 -R o/r --body x",
			fake,
			cache,
		);
		const { result } = await resolveCommand(
			"gh pr close 2 -R o/r",
			fake,
			cache,
		);
		assertResolved(result, "o/r", "repoFlag");
		assert.equal(metadataCalls(fake.calls).length, 1);
		assert.equal(cache.has("o/r"), true);
	}),
	fixture("same basename different owner", async () => {
		const fake = fakeExec({
			metadata: { "o1/r": metadata("o1/r"), "o2/r": metadata("o2/r") },
		});
		const cache = createRepoMetadataCache();
		await resolveCommand(
			"gh issue comment 1 -R o1/r --body x",
			fake,
			cache,
		);
		const { result } = await resolveCommand(
			"gh issue comment 2 -R o2/r --body x",
			fake,
			cache,
		);
		assertResolved(result, "o2/r", "repoFlag");
		assert.deepEqual(
			metadataCalls(fake.calls).map((call) => call.args[2]),
			["o1/r", "o2/r"],
		);
		assert.equal(cache.has("r"), false);
	}),
	fixture("different repos", async () => {
		const fake = fakeExec({
			metadata: { "o/r1": metadata("o/r1"), "o/r2": metadata("o/r2") },
		});
		const cache = createRepoMetadataCache();
		await resolveCommand(
			"gh issue comment 1 -R o/r1 --body x",
			fake,
			cache,
		);
		await resolveCommand(
			"gh issue comment 2 -R o/r2 --body x",
			fake,
			cache,
		);
		assert.deepEqual(
			metadataCalls(fake.calls).map((call) => call.args[2]),
			["o/r1", "o/r2"],
		);
	}),
] satisfies readonly Fixture<(typeof REQUIRED_REPO_IDS)[number]>[];

const visibilityPolicyFixtures = [
	fixture("private issue comment", async () => {
		const decision = evaluateBatchPolicy(
			[
				await policyWrite(
					"gh issue comment 1 -R o/r --body-file body.md",
					metadata("o/r", { isPrivate: true }),
					{
						"body.md": "private body",
					},
				),
			],
			{ hasUI: true },
		);
		assert.equal(decision.kind, "allow");
	}),
	fixture("public issue comment", async () => {
		const decision = await promptDecision(
			await policyWrite(
				"gh issue comment 1 -R o/r --body-file body.md",
				metadata("o/r"),
				{
					"body.md": "public body",
				},
			),
		);
		assert.match(
			decision.publicWrites[0]?.publicReason ?? "",
			/public repo/i,
		);
	}),
	fixture("public PR review", async () => {
		const decision = await promptDecision(
			await policyWrite(
				"gh pr review 2 -R o/r --approve",
				metadata("o/r"),
			),
		);
		assert.equal(
			decision.publicWrites[0]?.classification.writeClass,
			"pr.review",
		);
	}),
	fixture("public PR close", async () => {
		const decision = await promptDecision(
			await policyWrite("gh pr close 2 -R o/r", metadata("o/r")),
		);
		assert.equal(
			decision.publicWrites[0]?.classification.writeClass,
			"pr.close",
		);
	}),
	fixture("fork with public parent", async () => {
		const fork = metadata("o/private-fork", {
			isFork: true,
			isPrivate: true,
			parent: {
				isPrivate: false,
				nameWithOwner: "parent/public",
				visibility: "PUBLIC",
			},
		});
		const decision = await promptDecision(
			await policyWrite(
				"gh pr review 2 -R o/private-fork --approve",
				fork,
			),
		);
		assert.match(
			decision.publicWrites[0]?.publicReason ?? "",
			/public parent/i,
		);
	}),
	fixture("admin on public repo", async () => {
		const repo = metadata("o/r", { viewerPermission: "ADMIN" });
		const decision = await promptDecision(
			await policyWrite("gh issue comment 1 -R o/r --body x", repo),
		);
		assert.equal(
			decision.publicWrites[0]?.repo.viewerPermission,
			"ADMIN",
		);
	}),
	fixture("non-repo-scoped repo create", () => {
		const decision = evaluateBatchPolicy(
			[
				{
					classification: unsupportedClassification(
						"gh repo create o/new --public",
					),
				},
			],
			{ hasUI: true },
		);
		assert.equal(decision.kind, "block");
		assert.match(decision.reason, /not approved in v1/i);
	}),
	fixture("gist write", () => {
		const decision = evaluateBatchPolicy(
			[
				{
					classification: unsupportedClassification(
						"gh gist create file.txt --public",
					),
				},
			],
			{ hasUI: true },
		);
		assert.equal(decision.kind, "block");
		assert.match(decision.reason, /gist/i);
	}),
	fixture("repo-less API mutation", () => {
		const decision = evaluateBatchPolicy(
			[
				{
					classification: unsupportedClassification(
						"gh api /user/following/foo -X PUT",
					),
				},
			],
			{
				hasUI: true,
			},
		);
		assert.equal(decision.kind, "block");
		assert.match(decision.reason, /non-repo-scoped|unsupported/i);
	}),
] satisfies readonly Fixture<
	(typeof REQUIRED_VISIBILITY_IDS)[number]
>[];

const approvalSignatureFixtures = [
	fixture("exact single retry", async () => {
		const store = createApprovalSignatureStore();
		store.remember(
			await singleSignature(
				"gh issue comment 1 -R o/r --body-file a.md",
				{ "a.md": "body" },
			),
		);
		assert.equal(
			store.has(
				await singleSignature(
					"gh issue comment 1 -R o/r --body-file a.md",
					{ "a.md": "body" },
				),
			),
			true,
		);
	}),
	fixture("changed repo", async () => {
		const store = createApprovalSignatureStore();
		store.remember(
			await singleSignature(
				"gh issue comment 1 -R o/r --body-file a.md",
				{ "a.md": "body" },
			),
		);
		assert.equal(
			store.has(
				await singleSignature(
					"gh issue comment 1 -R o/other --body-file a.md",
					{ "a.md": "body" },
					"o/other",
				),
			),
			false,
		);
	}),
	fixture("changed target", async () =>
		assert.notEqual(
			(
				await singleSignature(
					"gh issue comment 2 -R o/r --body-file a.md",
					{ "a.md": "body" },
				)
			).digest,
			(
				await singleSignature(
					"gh issue comment 1 -R o/r --body-file a.md",
					{ "a.md": "body" },
				)
			).digest,
		),
	),
	fixture("changed flags", async () =>
		assert.notEqual(
			(await singleSignature("gh issue comment 1 -R o/r --body body"))
				.digest,
			(
				await singleSignature(
					"gh issue comment 1 -R o/r --body-file a.md",
					{ "a.md": "body" },
				)
			).digest,
		),
	),
	fixture("changed body file path", async () =>
		assert.notEqual(
			(
				await singleSignature(
					"gh issue comment 1 -R o/r --body-file b.md",
					{ "b.md": "body" },
				)
			).digest,
			(
				await singleSignature(
					"gh issue comment 1 -R o/r --body-file a.md",
					{ "a.md": "body" },
				)
			).digest,
		),
	),
	fixture("same body path changed contents", async () =>
		assert.notEqual(
			(
				await singleSignature(
					"gh issue comment 1 -R o/r --body-file a.md",
					{ "a.md": "second" },
				)
			).digest,
			(
				await singleSignature(
					"gh issue comment 1 -R o/r --body-file a.md",
					{ "a.md": "first" },
				)
			).digest,
		),
	),
	fixture("unreadable body file", async () => {
		const result = await resolvePayloadIdentity(
			writeClassification("gh issue comment 1 -R o/r --body-file a.md"),
			{
				readFile: async () => {
					throw new Error("EACCES");
				},
			},
		);
		assert.equal(result.kind, "blocked");
		assert.match(result.reason, /a\.md/);
		assert.match(result.guidance, /reviewable local file/i);
	}),
	fixture("short body file flag", async () => {
		const payload = await payloadFor(
			writeClassification("gh issue comment 1 -R o/r -F a.md"),
			{ "a.md": "body" },
		);
		assert.equal(payload.parts[0]?.kind, "file");
		assert.equal(payload.parts[0]?.path, "a.md");
	}),
	fixture("release asset file", async () => {
		const first = await singleSignature(
			"gh release create v1.0 dist/app.tar.gz -R o/r",
			{ "dist/app.tar.gz": "first" },
		);
		const second = await singleSignature(
			"gh release create v1.0 dist/app.tar.gz -R o/r",
			{ "dist/app.tar.gz": "second" },
		);
		assert.notEqual(first.digest, second.digest);
	}),
	fixture("identical ordered batch retry", async () => {
		const store = createApprovalSignatureStore();
		const first = await approvalWrite(
			"gh issue comment 1 -R o/r --body-file a.md",
			{ "a.md": "first" },
		);
		const second = await approvalWrite(
			"gh pr review 2 -R o/r --body second",
		);
		store.remember(buildApprovalSignature([first, second]));
		assert.equal(
			store.has(buildApprovalSignature([first, second])),
			true,
		);
	}),
	fixture("reordered batch", async () => {
		const first = await approvalWrite(
			"gh issue comment 1 -R o/r --body-file a.md",
			{ "a.md": "first" },
		);
		const second = await approvalWrite(
			"gh pr review 2 -R o/r --body second",
		);
		assert.notEqual(
			buildApprovalSignature([second, first]).digest,
			buildApprovalSignature([first, second]).digest,
		);
	}),
	fixture("subset batch", async () => {
		const first = await approvalWrite(
			"gh issue comment 1 -R o/r --body-file a.md",
			{ "a.md": "first" },
		);
		const second = await approvalWrite(
			"gh pr review 2 -R o/r --body second",
		);
		assert.notEqual(
			buildApprovalSignature([first]).digest,
			buildApprovalSignature([first, second]).digest,
		);
	}),
	fixture("superset batch", async () => {
		const first = await approvalWrite(
			"gh issue comment 1 -R o/r --body-file a.md",
			{ "a.md": "first" },
		);
		const second = await approvalWrite(
			"gh pr review 2 -R o/r --body second",
		);
		const third = await approvalWrite("gh pr close 3 -R o/r");
		assert.notEqual(
			buildApprovalSignature([first, second, third]).digest,
			buildApprovalSignature([first, second]).digest,
		);
	}),
] satisfies readonly Fixture<(typeof REQUIRED_APPROVAL_IDS)[number]>[];

const noUiPromptFixtures = [
	fixture("no UI public write", async () => {
		const harness = createHarness({
			exec: fakeHarnessExec({ "o/r": metadata("o/r") }),
			hasUI: false,
			readFile: async () => "body",
		});
		const result = await harness.runToolCall(
			bashToolCall(
				"gh issue comment 1 -R o/r --body-file .tmp/body.md",
			),
		);
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /no UI/i);
		assert.deepEqual(harness.uiCalls, []);
	}),
	fixture("no UI guidance", async () => {
		const harness = createHarness({
			exec: fakeHarnessExec({ "o/r": metadata("o/r") }),
			hasUI: false,
			readFile: async () => "body",
		});
		const result = await harness.runToolCall(
			bashToolCall(
				"gh pr create -R o/r --head branch --base main --title t --body-file .tmp/body.md",
			),
		);
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /\.tmp\//);
		assert.match(
			result?.reason ?? "",
			/drafts?|body|payload|exact `gh` command/i,
		);
		assert.match(result?.reason ?? "", /dry-run.*not.*safety/i);
	}),
	fixture("UI approval prompt", async () => {
		const command =
			"gh pr create -R o/r --head branch --base main --title t --body-file .tmp/body.md";
		const harness = createHarness({
			confirm: async () => false,
			exec: fakeHarnessExec({ "o/r": metadata("o/r") }),
			readFile: async () => "public PR body",
		});
		await harness.runToolCall(bashToolCall(command));
		const expectedFingerprint = (
			await singleSignature(command, {
				".tmp/body.md": "public PR body",
			})
		).digest;
		const body = harness.uiCalls[0]?.body ?? "";
		assert.equal(harness.uiCalls.length, 1);
		assert.match(body, /Repository: o\/r/);
		assert.match(body, /Visibility: PUBLIC/);
		assert.match(body, /Mutation: pr\.create/);
		assert.match(
			body,
			/Command: gh pr create -R o\/r --head branch --base main --title t --body-file \.tmp\/body\.md/,
		);
		assert.match(
			body,
			new RegExp(`Fingerprint: ${escapeRegExp(expectedFingerprint)}`),
		);
		assert.match(body, /Payload: --body-file \.tmp\/body\.md: sha256:/);
		assert.match(body, /Target: pr\.create/);
		assert.match(body, /dry-run.*may still push/i);
	}),
	fixture("UI denial", async () => {
		const harness = createHarness({
			confirm: async () => false,
			exec: fakeHarnessExec({ "o/r": metadata("o/r") }),
			readFile: async () => "body",
		});
		const result = await harness.runToolCall(
			bashToolCall("gh issue comment 1 -R o/r --body-file body.md"),
		);
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /denied/i);
		assert.equal(harness.uiCalls.length, 1);
	}),
	fixture("UI all-or-none approval", async () => {
		const command =
			"gh issue comment 1 -R o/r --body-file body.md && gh pr review 2 -R o/r --approve";
		const harness = createHarness({
			confirm: async () => true,
			exec: fakeHarnessExec({ "o/r": metadata("o/r") }),
			readFile: async () => "body",
		});
		assert.equal(
			await harness.runToolCall(bashToolCall(command)),
			undefined,
		);
		assert.equal(harness.uiCalls.length, 1);
		assert.match(harness.uiCalls[0]?.body ?? "", /Write count: 2/);
		assert.match(harness.uiCalls[0]?.body ?? "", /all-or-none/i);
		assert.equal(
			await harness.runToolCall(bashToolCall(command)),
			undefined,
		);
		assert.equal(harness.uiCalls.length, 1);
	}),
	fixture("stateful prefix implicit target", async () => {
		const harness = createHarness({
			exec: fakeHarnessExec({ "o/r": metadata("o/r") }),
			readFile: async () => "body",
		});
		const result = await harness.runToolCall(
			bashToolCall("cd ../public && gh issue comment 1 --body x"),
		);
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /cwd|environment/i);
		assert.equal(harness.execCalls.length, 0);

		const implicit = createHarness({
			exec: fakeHarnessExec({ "o/r": metadata("o/r") }),
			readFile: async () => "body",
		});
		const implicitResult = await implicit.runToolCall(
			bashToolCall(
				"git remote set-url origin https://github.com/other/repo.git; gh issue comment 1 --body x",
			),
		);
		assert.equal(implicitResult?.block, true);
		assert.match(
			implicitResult?.reason ?? "",
			/implicit-target|repository configuration/i,
		);
		assert.equal(implicit.execCalls.length, 0);
	}),
	fixture("file payload shell prefix", async () => {
		const harness = createHarness({
			exec: fakeHarnessExec({ "o/r": metadata("o/r") }),
			readFile: async () => "body",
		});
		const result = await harness.runToolCall(
			bashToolCall(
				"printf malicious > body.md; gh issue comment 1 -R o/r --body-file body.md",
			),
		);
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /file-backed payloads/i);
		assert.equal(harness.fileReadCalls.length, 0);

		const afterGh = createHarness({
			exec: fakeHarnessExec({ "o/r": metadata("o/r") }),
			readFile: async () => "body",
		});
		const afterGhResult = await afterGh.runToolCall(
			bashToolCall(
				"gh pr checkout 1 && gh issue comment 1 -R o/r --body-file body.md",
			),
		);
		assert.equal(afterGhResult?.block, true);
		assert.match(afterGhResult?.reason ?? "", /standalone `gh`/i);
		assert.equal(afterGh.fileReadCalls.length, 0);
	}),
] satisfies readonly Fixture<
	(typeof REQUIRED_NO_UI_PROMPT_IDS)[number]
>[];

const fixtureSections: ReadonlyArray<{
	fixtures: readonly Fixture[];
	name: string;
	requiredIds: readonly string[];
}> = [
	{
		fixtures: astExtractionFixtures,
		name: "AST extraction",
		requiredIds: REQUIRED_AST_IDS,
	},
	{
		fixtures: classificationFixtures,
		name: "classification",
		requiredIds: REQUIRED_CLASSIFICATION_IDS,
	},
	{
		fixtures: repoResolutionFixtures,
		name: "repo resolution",
		requiredIds: REQUIRED_REPO_IDS,
	},
	{
		fixtures: visibilityPolicyFixtures,
		name: "visibility policy",
		requiredIds: REQUIRED_VISIBILITY_IDS,
	},
	{
		fixtures: approvalSignatureFixtures,
		name: "approval signature",
		requiredIds: REQUIRED_APPROVAL_IDS,
	},
	{
		fixtures: noUiPromptFixtures,
		name: "no-UI/prompt",
		requiredIds: REQUIRED_NO_UI_PROMPT_IDS,
	},
];

test("implemented fixture IDs exactly match the required spec matrix", () => {
	for (const section of fixtureSections) {
		assertExactFixtureIds(
			section.name,
			section.requiredIds,
			section.fixtures,
		);
	}
});

for (const section of fixtureSections) {
	for (const item of section.fixtures) {
		test(`${section.name}: ${item.id}`, item.run);
	}
}
