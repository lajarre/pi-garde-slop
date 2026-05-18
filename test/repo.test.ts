import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyGhInvocation } from "../extensions/github-write-approval/classify.ts";
import {
	createRepoMetadataCache,
	type RepoExec,
	type RepoExecResult,
	type RepoMetadata,
	type RepoResolutionResult,
	resolveRepoForGhWrite,
} from "../extensions/github-write-approval/repo.ts";
import type {
	GhClassification,
	GhInvocation,
} from "../extensions/github-write-approval/types.ts";

const METADATA_FIELDS =
	"nameWithOwner,isPrivate,visibility,isFork,parent,viewerPermission";
const DEFAULT_CWD = "/work/project";

type ExecCall = {
	args: string[];
	command: string;
	options?: { cwd?: string; timeout?: number };
};

type FakeExecOptions = {
	metadata?: Record<string, RepoMetadata>;
	remoteUrl?: string | null;
};

function invocation(
	argv: string[],
	assignments: string[] = [],
): GhInvocation {
	return { assignments, argv };
}

function writeClassification(
	argv: string[],
	assignments: string[] = [],
): GhClassification & { kind: "write" } {
	const classification = classifyGhInvocation(
		invocation(argv, assignments),
	);

	assert.equal(classification.kind, "write");
	return classification;
}

function publicMetadata(nameWithOwner: string): RepoMetadata {
	return {
		isFork: false,
		isPrivate: false,
		nameWithOwner,
		parent: null,
		viewerPermission: "WRITE",
		visibility: "PUBLIC",
	};
}

function createFakeExec(options: FakeExecOptions = {}): {
	calls: ExecCall[];
	exec: RepoExec;
} {
	const calls: ExecCall[] = [];
	const metadata = options.metadata ?? {};
	const remoteUrl = options.remoteUrl;
	const exec: RepoExec = async (
		command: string,
		args: string[],
		execOptions?: { cwd?: string; timeout?: number },
	): Promise<RepoExecResult> => {
		calls.push({ args: [...args], command, options: execOptions });

		if (command === "gh" && args[0] === "repo" && args[1] === "view") {
			const repo = args[2] ?? "";
			const response = metadata[repo];
			return response
				? {
						exitCode: 0,
						stderr: "",
						stdout: `${JSON.stringify(response)}\n`,
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
			return remoteUrl
				? { exitCode: 0, stderr: "", stdout: `${remoteUrl}\n` }
				: {
						exitCode: 1,
						stderr: "fatal: no such remote",
						stdout: "",
					};
		}

		throw new Error(
			`unexpected exec call: ${command} ${args.join(" ")}`,
		);
	};

	return { calls, exec };
}

async function resolveWrite(
	classification: GhClassification & { kind: "write" },
	fake = createFakeExec({
		metadata: { "o/r": publicMetadata("o/r") },
	}),
	cache = createRepoMetadataCache(),
): Promise<{
	cache: ReturnType<typeof createRepoMetadataCache>;
	calls: ExecCall[];
	result: RepoResolutionResult;
}> {
	const result = await resolveRepoForGhWrite(classification, {
		cache,
		cwd: DEFAULT_CWD,
		exec: fake.exec,
	});

	return { cache, calls: fake.calls, result };
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

function metadataLookups(calls: ExecCall[]): ExecCall[] {
	return calls.filter(
		(call) => call.command === "gh" && call.args[0] === "repo",
	);
}

function gitRemoteLookups(calls: ExecCall[]): ExecCall[] {
	return calls.filter((call) => call.command === "git");
}

function assertOnlyMetadataLookup(
	calls: ExecCall[],
	repo: string,
): void {
	assert.deepEqual(
		calls.map((call) => ({ args: call.args, command: call.command })),
		[
			{
				args: ["repo", "view", repo, "--json", METADATA_FIELDS],
				command: "gh",
			},
		],
	);
}

test("resolves -R and --repo targets before cwd remote", async () => {
	for (const item of [
		{
			argv: ["gh", "issue", "comment", "1", "-R", "o/r", "--body", "x"],
			name: "short -R",
		},
		{
			argv: [
				"gh",
				"issue",
				"comment",
				"1",
				"--repo",
				"o/r",
				"--body",
				"x",
			],
			name: "long --repo",
		},
	] as const) {
		const fake = createFakeExec({
			metadata: { "o/r": publicMetadata("o/r") },
			remoteUrl: "https://github.com/other/default.git",
		});

		const { calls, result } = await resolveWrite(
			writeClassification([...item.argv]),
			fake,
		);

		assertResolved(result, "o/r", "repoFlag");
		assert.equal(gitRemoteLookups(calls).length, 0, item.name);
		assertOnlyMetadataLookup(calls, "o/r");
	}
});

test("resolves positional repo and REST path targets before cwd remote", async () => {
	for (const item of [
		{
			argv: ["gh", "repo", "edit", "o/r", "--description", "x"],
			source: "positionalRepo",
		},
		{
			argv: [
				"gh",
				"api",
				"repos/o/r/issues",
				"-X",
				"POST",
				"--input",
				"payload.json",
			],
			source: "restPath",
		},
	] as const) {
		const fake = createFakeExec({
			metadata: { "o/r": publicMetadata("o/r") },
			remoteUrl: "git@github.com:other/default.git",
		});

		const { calls, result } = await resolveWrite(
			writeClassification([...item.argv]),
			fake,
		);

		assertResolved(result, "o/r", item.source);
		assert.equal(gitRemoteLookups(calls).length, 0);
		assertOnlyMetadataLookup(calls, "o/r");
	}
});

test("resolves GH_REPO assignments when no command target exists", async () => {
	const { calls, result } = await resolveWrite(
		writeClassification(
			["gh", "issue", "comment", "1", "--body", "x"],
			["GH_REPO=o/r"],
		),
	);

	assertResolved(result, "o/r", "ghRepoAssignment");
	assertOnlyMetadataLookup(calls, "o/r");
});

test("returns a conflict when explicit target sources disagree", async () => {
	const fake = createFakeExec({
		metadata: {
			"o/r1": publicMetadata("o/r1"),
			"o/r2": publicMetadata("o/r2"),
		},
	});

	const { calls, result } = await resolveWrite(
		writeClassification(
			[
				"gh",
				"api",
				"repos/o/r2/issues",
				"-X",
				"POST",
				"--input",
				"payload.json",
			],
			["GH_REPO=o/r1"],
		),
		fake,
	);

	assert.equal(result.kind, "conflict");
	assert.match(result.reason, /conflicting.*repo targets/i);
	assert.match(result.guidance, /rewrite/i);
	assert.deepEqual(result.sources, [
		{ repo: "o/r2", source: "restPath" },
		{ repo: "o/r1", source: "ghRepoAssignment" },
	]);
	assert.deepEqual(calls, []);
});

test("falls back to cwd GitHub remote and preserves owner/repo", async () => {
	const fake = createFakeExec({
		metadata: { "o/r": publicMetadata("o/r") },
		remoteUrl: "git@github.com:o/r.git",
	});

	const { calls, result } = await resolveWrite(
		writeClassification(["gh", "issue", "comment", "1", "--body", "x"]),
		fake,
	);

	assertResolved(result, "o/r", "cwdRemote");
	assert.deepEqual(
		gitRemoteLookups(calls).map((call) => call.args),
		[["remote", "get-url", "origin"]],
	);
	assert.deepEqual(
		metadataLookups(calls).map((call) => call.args),
		[["repo", "view", "o/r", "--json", METADATA_FIELDS]],
	);
});

test("returns unresolved when no explicit target or cwd remote exists", async () => {
	const fake = createFakeExec({ remoteUrl: null });

	const { calls, result } = await resolveWrite(
		writeClassification(["gh", "issue", "comment", "1", "--body", "x"]),
		fake,
	);

	assert.equal(result.kind, "unresolved");
	assert.match(result.reason, /unable to resolve/i);
	assert.match(result.guidance, /-R owner\/repo/i);
	assert.equal(metadataLookups(calls).length, 0);
	assert.equal(gitRemoteLookups(calls).length, 1);
});

test("reuses cached metadata for two writes to the same repo", async () => {
	const fake = createFakeExec({
		metadata: { "o/r": publicMetadata("o/r") },
	});
	const cache = createRepoMetadataCache();
	const first = await resolveWrite(
		writeClassification([
			"gh",
			"issue",
			"comment",
			"1",
			"-R",
			"o/r",
			"--body",
			"x",
		]),
		fake,
		cache,
	);
	const second = await resolveWrite(
		writeClassification(["gh", "pr", "close", "2", "-R", "o/r"]),
		fake,
		cache,
	);

	assertResolved(first.result, "o/r", "repoFlag");
	assertResolved(second.result, "o/r", "repoFlag");
	assert.equal(metadataLookups(fake.calls).length, 1);
	assert.equal(cache.has("o/r"), true);
	assert.equal(cache.has("r"), false);
});

test("keeps same-basename metadata cache entries separate by nameWithOwner", async () => {
	const fake = createFakeExec({
		metadata: {
			"o1/r": publicMetadata("o1/r"),
			"o2/r": publicMetadata("o2/r"),
		},
	});
	const cache = createRepoMetadataCache();
	const first = await resolveWrite(
		writeClassification([
			"gh",
			"issue",
			"comment",
			"1",
			"-R",
			"o1/r",
			"--body",
			"x",
		]),
		fake,
		cache,
	);
	const second = await resolveWrite(
		writeClassification([
			"gh",
			"issue",
			"comment",
			"2",
			"-R",
			"o2/r",
			"--body",
			"x",
		]),
		fake,
		cache,
	);

	assertResolved(first.result, "o1/r", "repoFlag");
	assertResolved(second.result, "o2/r", "repoFlag");
	assert.deepEqual(
		metadataLookups(fake.calls).map((call) => call.args[2]),
		["o1/r", "o2/r"],
	);
	assert.equal(cache.has("o1/r"), true);
	assert.equal(cache.has("o2/r"), true);
	assert.equal(cache.has("r"), false);
});
