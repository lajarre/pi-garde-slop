import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApprovalSignature } from "../approval.ts";
import { classifyGhInvocation } from "../classify.ts";
import { resolvePayloadIdentity } from "../payload.ts";
import { evaluateBatchPolicy } from "../policy.ts";
import { formatApprovalPrompt } from "../prompt.ts";
import type {
	ApprovalWriteInput,
	GhClassification,
	GhInvocation,
	PayloadIdentity,
	RepoMetadata,
	RepoResolutionResult,
	ResolvedRepoTarget,
} from "../types.ts";

function invocation(argv: string[]): GhInvocation {
	return { assignments: [], argv };
}

function classify(argv: string[]): GhClassification {
	return classifyGhInvocation(invocation(argv));
}

function writeClassification(
	argv: string[],
): GhClassification & { kind: "write" } {
	const classification = classify(argv);

	assert.equal(classification.kind, "write");
	return classification;
}

function unsupportedClassification(
	argv: string[],
): GhClassification & { kind: "unsupportedWrite" } {
	const classification = classify(argv);

	assert.equal(classification.kind, "unsupportedWrite");
	return classification;
}

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

	assert.equal(result.kind, "resolved");
	return result.identity;
}

async function policyWrite(
	argv: string[],
	repo: RepoMetadata,
	files: Record<string, string> = {},
): Promise<
	ApprovalWriteInput & { repoResolution: RepoResolutionResult }
> {
	const classification = writeClassification(argv);
	return {
		classification,
		payload: await payloadFor(classification, files),
		repo,
		repoResolution: resolvedRepo(repo),
		target: target(repo.nameWithOwner),
	};
}

test("allows private repo writes without approval", async () => {
	const decision = evaluateBatchPolicy(
		[
			await policyWrite(
				[
					"gh",
					"issue",
					"comment",
					"1",
					"-R",
					"o/private",
					"--body-file",
					"body.md",
				],
				metadata("o/private", {
					isPrivate: true,
					visibility: "PRIVATE",
				}),
				{ "body.md": "private body" },
			),
		],
		{ hasUI: true },
	);

	assert.equal(decision.kind, "allow");
	assert.match(decision.reason, /private/i);
});

test("prompts for public repo writes and never lets admin permission bypass the gate", async () => {
	const adminPublic = metadata("o/r", { viewerPermission: "ADMIN" });
	const decision = evaluateBatchPolicy(
		[
			await policyWrite(
				[
					"gh",
					"issue",
					"comment",
					"1",
					"-R",
					"o/r",
					"--body-file",
					"body.md",
				],
				adminPublic,
				{ "body.md": "public body" },
			),
		],
		{ hasUI: true },
	);

	assert.equal(decision.kind, "prompt");
	assert.equal(decision.publicWrites.length, 1);
	assert.match(
		decision.publicWrites[0]?.publicReason ?? "",
		/public repo/i,
	);
	assert.equal(
		decision.publicWrites[0]?.repo.viewerPermission,
		"ADMIN",
	);
});

test("prompts for pull request writes against forks with public parents", async () => {
	const fork = metadata("o/private-fork", {
		isFork: true,
		isPrivate: true,
		parent: {
			isPrivate: false,
			nameWithOwner: "upstream/public",
			visibility: "PUBLIC",
		},
		visibility: "PRIVATE",
	});
	const decision = evaluateBatchPolicy(
		[
			await policyWrite(
				[
					"gh",
					"pr",
					"review",
					"2",
					"-R",
					"o/private-fork",
					"--approve",
				],
				fork,
			),
		],
		{ hasUI: true },
	);

	assert.equal(decision.kind, "prompt");
	assert.match(
		decision.publicWrites[0]?.publicReason ?? "",
		/public parent.*upstream\/public/i,
	);
});

test("blocks unsupported, repo-less, unresolved, and not-yet-existing writes", () => {
	const unsupportedCases = [
		unsupportedClassification([
			"gh",
			"gist",
			"create",
			"file.txt",
			"--public",
		]),
		unsupportedClassification([
			"gh",
			"api",
			"/user/following/foo",
			"-X",
			"PUT",
		]),
		unsupportedClassification([
			"gh",
			"repo",
			"create",
			"o/new",
			"--public",
		]),
	];

	for (const classification of unsupportedCases) {
		const decision = evaluateBatchPolicy([{ classification }], {
			hasUI: true,
		});

		assert.equal(decision.kind, "block");
		assert.match(decision.reason, /detected/i);
		assert.match(decision.reason, /intentionally not approved in v1/i);
		assert.match(decision.guidance, /rewrite|manual review/i);
	}

	const unresolved = evaluateBatchPolicy(
		[
			{
				classification: writeClassification([
					"gh",
					"issue",
					"comment",
					"1",
					"--body",
					"x",
				]),
				repoResolution: {
					guidance: "add -R owner/repo",
					kind: "unresolved",
					reason: "no repo target",
				},
			},
		],
		{ hasUI: true },
	);
	assert.equal(unresolved.kind, "block");
	assert.match(unresolved.guidance, /-R owner\/repo/i);

	const missingRepo = evaluateBatchPolicy(
		[
			{
				classification: writeClassification([
					"gh",
					"issue",
					"comment",
					"1",
					"-R",
					"o/missing",
					"--body",
					"x",
				]),
				repoResolution: {
					guidance: "verify the repository exists",
					kind: "metadataError",
					reason: "could not resolve to an existing repository",
					target: target("o/missing"),
				},
			},
		],
		{ hasUI: true },
	);
	assert.equal(missingRepo.kind, "block");
	assert.match(missingRepo.reason, /existing repository/i);
});

test("blocks public writes without UI and includes local review guidance", async () => {
	const decision = evaluateBatchPolicy(
		[
			await policyWrite(
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
					".tmp/body.md",
				],
				metadata("o/r"),
				{ ".tmp/body.md": "pr body" },
			),
		],
		{ hasUI: false },
	);

	assert.equal(decision.kind, "block");
	assert.match(decision.reason, /no ui/i);
	assert.match(decision.guidance, /\.tmp\//);
	assert.match(decision.guidance, /--body-file/);
	assert.match(decision.guidance, /--notes-file/);
	assert.match(decision.guidance, /gh api --input file\.json/);
	assert.match(decision.guidance, /dry-run.*not.*safety/i);
});

test("formats approval prompts with review rows, fingerprints, payload identities, targets, and advice", async () => {
	const first = await policyWrite(
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
			".tmp/body.md",
		],
		metadata("o/r", { viewerPermission: "ADMIN" }),
		{ ".tmp/body.md": "body for prompt" },
	);
	const second = await policyWrite(
		[
			"gh",
			"release",
			"create",
			"v1.0",
			"-R",
			"o/r",
			"--notes-file",
			".tmp/notes.md",
		],
		metadata("o/r"),
		{ ".tmp/notes.md": "release notes" },
	);
	const third = await policyWrite(
		[
			"gh",
			"api",
			"repos/o/r/issues",
			"-X",
			"POST",
			"--input",
			".tmp/payload.json",
		],
		metadata("o/r"),
		{ ".tmp/payload.json": '{"title":"issue"}' },
	);
	const decision = evaluateBatchPolicy([first, second, third], {
		hasUI: true,
	});

	assert.equal(decision.kind, "prompt");
	const prompt = formatApprovalPrompt(
		decision.publicWrites,
		decision.signature,
	);

	for (const write of [first, second, third]) {
		const fingerprint = buildApprovalSignature([write]).digest;

		assert.match(prompt, new RegExp(fingerprint.replace(":", ":")));
	}
	assert.match(prompt, /Repository: o\/r/);
	assert.match(prompt, /Visibility: PUBLIC/);
	assert.match(prompt, /Viewer permission: ADMIN/);
	assert.match(prompt, /Mutation: pr\.create/);
	assert.match(prompt, /Mutation: release\.create/);
	assert.match(prompt, /Mutation: api\.post/);
	assert.match(prompt, /Command: gh pr create/);
	assert.match(prompt, /Payload: --body-file \.tmp\/body\.md: sha256:/);
	assert.match(
		prompt,
		/Payload: --notes-file \.tmp\/notes\.md: sha256:/,
	);
	assert.match(
		prompt,
		/Payload: --input \.tmp\/payload\.json: sha256:/,
	);
	assert.match(prompt, /Target: pr\.create/);
	assert.match(prompt, /Target: release\.create:v1\.0/);
	assert.match(prompt, /Target: api:repos\/o\/r\/issues/);
	assert.match(prompt, /dry-run.*may still push/i);
	assert.match(prompt, /--match-head-commit|--verify-tag/i);
	assert.match(prompt, /--body-file/i);
	assert.match(prompt, /--notes-file/i);
	assert.match(prompt, /--input file\.json/i);
});

test("redacts raw secret and inline payload values in approval prompts", async () => {
	const write = await policyWrite(
		[
			"gh",
			"secret",
			"set",
			"TOKEN",
			"-R",
			"o/r",
			"--body",
			"super-secret-value",
		],
		metadata("o/r"),
	);
	const decision = evaluateBatchPolicy([write], { hasUI: true });

	assert.equal(decision.kind, "prompt");
	const prompt = formatApprovalPrompt(
		decision.publicWrites,
		decision.signature,
	);

	assert.match(
		prompt,
		/gh secret set TOKEN -R o\/r --body \[redacted inline payload\]/,
	);
	assert.match(
		prompt,
		/Payload: --body: \[redacted inline payload\], sha256:/,
	);
	assert.match(prompt, /sha256:/);
	assert.doesNotMatch(prompt, /super-secret-value/);
});

test("redacts concatenated gh api field values in approval prompts", async () => {
	const write = await policyWrite(
		["gh", "api", "repos/o/r/issues", "-fbody=inline-api-secret"],
		metadata("o/r"),
	);
	const decision = evaluateBatchPolicy([write], { hasUI: true });

	assert.equal(decision.kind, "prompt");
	const prompt = formatApprovalPrompt(
		decision.publicWrites,
		decision.signature,
	);

	assert.match(
		prompt,
		/Command: gh api repos\/o\/r\/issues -f \[redacted inline payload\]/,
	);
	assert.match(
		prompt,
		/Payload: -f: \[redacted inline payload\], sha256:/,
	);
	assert.doesNotMatch(prompt, /inline-api-secret/);
});
