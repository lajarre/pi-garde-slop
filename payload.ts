import { createHash } from "node:crypto";
import type {
	GhClassification,
	PayloadFileReader,
	PayloadFileReadResult,
	PayloadIdentity,
	PayloadIdentityResult,
	PayloadPartIdentity,
} from "./types.ts";

export type {
	PayloadFileReader,
	PayloadIdentity,
	PayloadIdentityResult,
	PayloadPartIdentity,
} from "./types.ts";

export interface ResolvePayloadIdentityOptions {
	readFile?: PayloadFileReader;
}

type PayloadReference =
	| { flag: string; kind: "file"; path: string }
	| { flag: string; kind: "inline"; value: string };

const FILE_VALUE_FLAGS = new Set([
	"--body-file",
	"--notes-file",
	"--input",
]);
const INLINE_VALUE_FLAGS = new Set(["--body", "--notes"]);
const API_FIELD_FLAGS = new Set(["-f", "-F", "--field", "--raw-field"]);

export async function resolvePayloadIdentity(
	classification: GhClassification,
	options: ResolvePayloadIdentityOptions = {},
): Promise<PayloadIdentityResult> {
	const references = payloadReferences(
		classification.signatureInput.argv,
	);
	const parts: PayloadPartIdentity[] = [];

	for (const reference of references) {
		if (reference.kind === "inline") {
			parts.push({
				digest: sha256(reference.value),
				flag: reference.flag,
				kind: "inline",
			});
			continue;
		}

		const fileResult = await digestPayloadFile(reference, options);
		if (fileResult.kind === "blocked") {
			return fileResult;
		}
		parts.push(fileResult.part);
	}

	return {
		identity: buildIdentity(parts),
		kind: "resolved",
	};
}

function payloadReferences(
	argv: readonly string[],
): PayloadReference[] {
	const references: PayloadReference[] = [];

	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index] ?? "";
		const next = argv[index + 1];

		const fileEquals = equalsFlagValue(token, FILE_VALUE_FLAGS);
		if (fileEquals) {
			references.push(fileReference(fileEquals.flag, fileEquals.value));
			continue;
		}

		if (FILE_VALUE_FLAGS.has(token)) {
			references.push(fileReference(token, next ?? ""));
			index += 1;
			continue;
		}

		const inlineEquals = equalsFlagValue(token, INLINE_VALUE_FLAGS);
		if (inlineEquals) {
			references.push({
				flag: inlineEquals.flag,
				kind: "inline",
				value: inlineEquals.value,
			});
			continue;
		}

		if (INLINE_VALUE_FLAGS.has(token)) {
			references.push({
				flag: token,
				kind: "inline",
				value: next ?? "",
			});
			index += 1;
			continue;
		}

		const fieldEquals = equalsFlagValue(token, API_FIELD_FLAGS);
		if (fieldEquals) {
			references.push(
				apiFieldReference(fieldEquals.flag, fieldEquals.value),
			);
			continue;
		}

		if (API_FIELD_FLAGS.has(token)) {
			references.push(apiFieldReference(token, next ?? ""));
			index += 1;
		}
	}

	return references;
}

function equalsFlagValue(
	token: string,
	flags: ReadonlySet<string>,
): { flag: string; value: string } | null {
	for (const flag of flags) {
		const prefix = `${flag}=`;
		if (token.startsWith(prefix)) {
			return { flag, value: token.slice(prefix.length) };
		}
	}
	return null;
}

function fileReference(flag: string, path: string): PayloadReference {
	return { flag, kind: "file", path };
}

function apiFieldReference(
	flag: string,
	value: string,
): PayloadReference {
	const filePath = fileBackedApiFieldPath(value);
	return filePath
		? { flag, kind: "file", path: filePath }
		: { flag, kind: "inline", value };
}

function fileBackedApiFieldPath(value: string): string | null {
	const separator = value.indexOf("=");
	if (separator < 0) {
		return null;
	}

	const fieldValue = value.slice(separator + 1);
	return fieldValue.startsWith("@") ? fieldValue.slice(1) : null;
}

async function digestPayloadFile(
	reference: PayloadReference & { kind: "file" },
	options: ResolvePayloadIdentityOptions,
): Promise<
	| { kind: "resolved"; part: PayloadPartIdentity }
	| { guidance: string; kind: "blocked"; reason: string }
> {
	if (!reference.path || reference.path === "-") {
		return blockedFileResult(
			reference.path,
			"payload file path is missing or uses opaque stdin",
		);
	}

	if (!options.readFile) {
		return blockedFileResult(
			reference.path,
			"no deterministic file reader is available",
		);
	}

	let content: PayloadFileReadResult;
	try {
		content = await options.readFile(reference.path);
	} catch (error) {
		return blockedFileResult(reference.path, errorMessage(error));
	}

	return {
		kind: "resolved",
		part: {
			digest: sha256(content),
			flag: reference.flag,
			kind: "file",
			path: reference.path,
		},
	};
}

function blockedFileResult(
	path: string,
	reason: string,
): { guidance: string; kind: "blocked"; reason: string } {
	return {
		guidance:
			"rewrite the command to reference a deterministic, reviewable local file such as `.tmp/body.md` or `.tmp/payload.json`, then rerun approval",
		kind: "blocked",
		reason: `unable to read payload file ${path || "<missing>"}: ${reason}`,
	};
}

function buildIdentity(parts: PayloadPartIdentity[]): PayloadIdentity {
	const digest = sha256(stableStringify(parts));
	return {
		digest,
		digestAlgorithm: "sha256",
		displaySummary: displaySummary(parts),
		parts,
	};
}

function displaySummary(parts: readonly PayloadPartIdentity[]): string {
	if (parts.length === 0) {
		return "no payload content detected";
	}

	return parts
		.map((part) => {
			const digest = `sha256:${part.digest}`;
			if (part.kind === "file") {
				return `${part.flag} ${part.path}: ${digest}`;
			}
			return `${part.flag}: [redacted inline payload], ${digest}`;
		})
		.join("; ");
}

function sha256(value: string | Uint8Array): string {
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
