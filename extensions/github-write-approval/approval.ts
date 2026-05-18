import { createHash } from "node:crypto";
import type {
	ApprovalSignature,
	ApprovalSignatureStore,
	ApprovalWriteInput,
	PayloadIdentity,
	RepoMetadata,
	ResolvedRepoTarget,
	WriteGhClassification,
} from "./types.ts";

export type {
	ApprovalSignature,
	ApprovalSignatureStore,
	ApprovalWriteInput,
} from "./types.ts";

interface SignatureWriteInput {
	command: string;
	payload: SignaturePayloadInput;
	repo: SignatureRepoInput;
	target: SignatureTargetInput;
	targetIdentity: string;
	writeClass: string;
}

interface SignaturePayloadInput {
	digest: string;
	parts: Array<{
		digest: string;
		flag: string;
		kind: string;
		path?: string;
	}>;
}

interface SignatureRepoInput {
	isFork: boolean;
	isPrivate: boolean;
	nameWithOwner: string;
	parent: RepoMetadata["parent"];
	viewerPermission: string;
	visibility: string;
}

interface SignatureTargetInput {
	repo: string;
	source: string;
}

const VALUE_TAKING_FLAGS = new Set([
	"--add-label",
	"--base",
	"--body",
	"--body-file",
	"--color",
	"--description",
	"--field",
	"--head",
	"--input",
	"--match-head-commit",
	"--method",
	"--notes",
	"--notes-file",
	"--raw-field",
	"--repo",
	"--title",
	"-F",
	"-R",
	"-X",
	"-f",
]);

export function buildApprovalSignature(
	writes: readonly ApprovalWriteInput[],
): ApprovalSignature {
	const signatureInput = {
		version: 1,
		writes: writes.map(writeSignatureInput),
	};
	const digest = `sha256:${sha256(stableStringify(signatureInput))}`;
	const kind = writes.length === 1 ? "single" : "batch";

	return {
		digest,
		displaySummary: `${kind} approval ${digest} for ${writes.length} write(s): ${writes
			.map((write) => write.payload.displaySummary)
			.join(" | ")}`,
		kind,
		writeCount: writes.length,
	};
}

export function createApprovalSignatureStore(): ApprovalSignatureStore {
	const signatures = new Set<string>();

	return {
		has(signature: ApprovalSignature): boolean {
			return signatures.has(signature.digest);
		},
		remember(signature: ApprovalSignature): void {
			signatures.add(signature.digest);
		},
	};
}

function writeSignatureInput(
	write: ApprovalWriteInput,
): SignatureWriteInput {
	return {
		command: write.classification.normalizedCommand,
		payload: payloadSignatureInput(write.payload),
		repo: repoSignatureInput(write.repo),
		target: targetSignatureInput(write.target),
		targetIdentity: targetIdentity(write.classification, write.target),
		writeClass: write.classification.writeClass,
	};
}

function payloadSignatureInput(
	payload: PayloadIdentity,
): SignaturePayloadInput {
	return {
		digest: payload.digest,
		parts: payload.parts.map((part) => ({
			digest: part.digest,
			flag: part.flag,
			kind: part.kind,
			...(part.path ? { path: part.path } : {}),
		})),
	};
}

function repoSignatureInput(repo: RepoMetadata): SignatureRepoInput {
	return {
		isFork: repo.isFork,
		isPrivate: repo.isPrivate,
		nameWithOwner: repo.nameWithOwner,
		parent: repo.parent,
		viewerPermission: repo.viewerPermission,
		visibility: repo.visibility,
	};
}

function targetSignatureInput(
	target: ResolvedRepoTarget,
): SignatureTargetInput {
	return {
		repo: target.repo,
		source: target.source,
	};
}

function targetIdentity(
	classification: WriteGhClassification,
	target: ResolvedRepoTarget,
): string {
	const argv = classification.signatureInput.argv;
	const group = argv[1] ?? "";
	const subcommand = argv[2] ?? "";

	if (group === "api") {
		return `api:${apiEndpoint(argv) ?? "<unknown>"}`;
	}
	if (group === "repo") {
		return `repo:${target.repo}`;
	}

	const positional = firstPositionalAfterSubcommand(argv);
	return positional
		? `${group}.${subcommand}:${positional}`
		: `${group}.${subcommand}:${target.repo}`;
}

function apiEndpoint(argv: readonly string[]): string | null {
	for (let index = 2; index < argv.length; index += 1) {
		const token = argv[index] ?? "";
		if (token === "--") {
			return argv[index + 1] ?? null;
		}
		if (flagConsumesNext(token)) {
			index += 1;
			continue;
		}
		if (!token.startsWith("-") || token === "-") {
			return token;
		}
	}
	return null;
}

function firstPositionalAfterSubcommand(
	argv: readonly string[],
): string | null {
	for (let index = 3; index < argv.length; index += 1) {
		const token = argv[index] ?? "";
		if (token === "--") {
			return argv[index + 1] ?? null;
		}
		if (flagConsumesNext(token)) {
			index += 1;
			continue;
		}
		if (token.startsWith("-")) {
			continue;
		}
		return token;
	}
	return null;
}

function flagConsumesNext(token: string): boolean {
	return VALUE_TAKING_FLAGS.has(token);
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	}
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map(
				(key) =>
					`${JSON.stringify(key)}:${stableStringify(record[key])}`,
			)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}
