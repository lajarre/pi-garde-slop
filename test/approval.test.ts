import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
	buildApprovalSignature,
	createApprovalSignatureStore,
} from "../approval.ts";
import { classifyGhInvocation } from "../classify.ts";
import { resolvePayloadIdentity } from "../payload.ts";
import type {
	ApprovalWriteInput,
	GhClassification,
	GhInvocation,
	PayloadIdentity,
	RepoMetadata,
	ResolvedRepoTarget,
} from "../types.ts";

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function invocation(argv: string[]): GhInvocation {
	return { assignments: [], argv };
}

function writeClassification(
	argv: string[],
): GhClassification & { kind: "write" } {
	const classification = classifyGhInvocation(invocation(argv));

	assert.equal(classification.kind, "write");
	return classification;
}

function metadata(nameWithOwner: string): RepoMetadata {
	return {
		isFork: false,
		isPrivate: false,
		nameWithOwner,
		parent: null,
		viewerPermission: "WRITE",
		visibility: "PUBLIC",
	};
}

function target(repo: string): ResolvedRepoTarget {
	return { repo, source: "repoFlag" };
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

async function approvalWrite(
	argv: string[],
	files: Record<string, string> = {},
	repo = "o/r",
): Promise<ApprovalWriteInput> {
	const classification = writeClassification(argv);
	return {
		classification,
		payload: await payloadFor(classification, files),
		repo: metadata(repo),
		target: target(repo),
	};
}

test("computes sha-256 identities for inline payload values without displaying raw values", async () => {
	const classification = writeClassification([
		"gh",
		"issue",
		"comment",
		"1",
		"-R",
		"o/r",
		"--body",
		"do not leak this inline body",
	]);
	const payload = await payloadFor(classification);

	assert.equal(payload.digestAlgorithm, "sha256");
	assert.equal(payload.parts.length, 1);
	assert.equal(payload.parts[0]?.kind, "inline");
	assert.equal(
		payload.parts[0]?.digest,
		sha256("do not leak this inline body"),
	);
	assert.match(payload.displaySummary, /--body/);
	assert.match(payload.displaySummary, /sha256:/);
	assert.doesNotMatch(payload.displaySummary, /do not leak/);
});

test("computes content-based identities for file-backed payloads without displaying raw file contents", async () => {
	const classification = writeClassification([
		"gh",
		"issue",
		"comment",
		"1",
		"-R",
		"o/r",
		"--body-file",
		"a.md",
	]);
	const payload = await payloadFor(classification, {
		"a.md": "file body\n",
	});

	assert.equal(payload.parts.length, 1);
	assert.deepEqual(payload.parts[0], {
		digest: sha256("file body\n"),
		flag: "--body-file",
		kind: "file",
		path: "a.md",
	});
	assert.match(payload.displaySummary, /--body-file a\.md/);
	assert.match(payload.displaySummary, /sha256:/);
	assert.doesNotMatch(payload.displaySummary, /file body/);
});

test("fails closed with rewrite guidance when a payload file cannot be read", async () => {
	const classification = writeClassification([
		"gh",
		"issue",
		"comment",
		"1",
		"-R",
		"o/r",
		"--body-file",
		"missing.md",
	]);
	const result = await resolvePayloadIdentity(classification, {
		readFile: async () => {
			throw new Error("EACCES: permission denied");
		},
	});

	assert.equal(result.kind, "blocked");
	assert.match(result.reason, /missing\.md/);
	assert.match(result.reason, /permission denied/);
	assert.match(result.guidance, /rewrite/i);
	assert.match(result.guidance, /reviewable local file/i);
});

test("reuses an exact single-write approval signature only when command, repo, target, and payload match", async () => {
	const store = createApprovalSignatureStore();
	const approvedWrite = await approvalWrite(
		["gh", "issue", "comment", "1", "-R", "o/r", "--body-file", "a.md"],
		{ "a.md": "approved body" },
	);
	const approvedSignature = buildApprovalSignature([approvedWrite]);

	assert.equal(store.has(approvedSignature), false);
	store.remember(approvedSignature);
	assert.equal(store.has(approvedSignature), true);
	assert.equal(
		store.has(
			buildApprovalSignature([
				await approvalWrite(
					[
						"gh",
						"issue",
						"comment",
						"1",
						"-R",
						"o/r",
						"--body-file",
						"a.md",
					],
					{ "a.md": "approved body" },
				),
			]),
		),
		true,
	);
	assert.equal(
		store.has(
			buildApprovalSignature([
				await approvalWrite(
					[
						"gh",
						"issue",
						"comment",
						"1",
						"-R",
						"o/other",
						"--body-file",
						"a.md",
					],
					{ "a.md": "approved body" },
					"o/other",
				),
			]),
		),
		false,
	);
	assert.equal(
		store.has(
			buildApprovalSignature([
				await approvalWrite(
					[
						"gh",
						"issue",
						"comment",
						"2",
						"-R",
						"o/r",
						"--body-file",
						"a.md",
					],
					{ "a.md": "approved body" },
				),
			]),
		),
		false,
	);
});

test("changes approval signatures when a body file path or file contents change", async () => {
	const first = buildApprovalSignature([
		await approvalWrite(
			[
				"gh",
				"issue",
				"comment",
				"1",
				"-R",
				"o/r",
				"--body-file",
				"a.md",
			],
			{ "a.md": "same body" },
		),
	]);
	const changedPath = buildApprovalSignature([
		await approvalWrite(
			[
				"gh",
				"issue",
				"comment",
				"1",
				"-R",
				"o/r",
				"--body-file",
				"b.md",
			],
			{ "b.md": "same body" },
		),
	]);
	const changedContents = buildApprovalSignature([
		await approvalWrite(
			[
				"gh",
				"issue",
				"comment",
				"1",
				"-R",
				"o/r",
				"--body-file",
				"a.md",
			],
			{ "a.md": "changed body" },
		),
	]);

	assert.notEqual(changedPath.digest, first.digest);
	assert.notEqual(changedContents.digest, first.digest);
});

test("keeps ordered batch signatures all-or-none and non-decomposable", async () => {
	const store = createApprovalSignatureStore();
	const first = await approvalWrite(
		["gh", "issue", "comment", "1", "-R", "o/r", "--body-file", "a.md"],
		{ "a.md": "first" },
	);
	const second = await approvalWrite([
		"gh",
		"pr",
		"review",
		"2",
		"-R",
		"o/r",
		"--body",
		"second",
	]);
	const approvedBatch = buildApprovalSignature([first, second]);

	store.remember(approvedBatch);

	assert.equal(
		store.has(buildApprovalSignature([first, second])),
		true,
	);
	assert.equal(
		store.has(buildApprovalSignature([second, first])),
		false,
	);
	assert.equal(store.has(buildApprovalSignature([first])), false);
	assert.equal(
		store.has(buildApprovalSignature([first, second, first])),
		false,
	);
});

test("redacts secret and inline payload values while keeping digest-based identity", async () => {
	const classification = writeClassification([
		"gh",
		"secret",
		"set",
		"TOKEN",
		"-R",
		"o/r",
		"--body",
		"super-secret-value",
	]);
	const payload = await payloadFor(classification);
	const signature = buildApprovalSignature([
		{
			classification,
			payload,
			repo: metadata("o/r"),
			target: target("o/r"),
		},
	]);

	assert.equal(payload.parts[0]?.digest, sha256("super-secret-value"));
	assert.match(payload.displaySummary, /redacted/);
	assert.doesNotMatch(payload.displaySummary, /super-secret-value/);
	assert.doesNotMatch(signature.displaySummary, /super-secret-value/);
	assert.match(signature.displaySummary, /sha256:/);
});
