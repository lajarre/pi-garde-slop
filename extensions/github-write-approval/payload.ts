import { createHash } from "node:crypto";
import type {
	GhClassification,
	GhWriteClass,
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

const BODY_WRITE_CLASSES = new Set<GhWriteClass>([
	"issue.comment",
	"issue.create",
	"pr.comment",
	"pr.create",
	"pr.review",
]);
const RELEASE_VALUE_FLAGS = new Set([
	"--discussion-category",
	"--notes",
	"--notes-file",
	"--repo",
	"--target",
	"--title",
	"-F",
	"-R",
	"-n",
]);

export async function resolvePayloadIdentity(
	classification: GhClassification,
	options: ResolvePayloadIdentityOptions = {},
): Promise<PayloadIdentityResult> {
	const references = payloadReferences(classification);
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

export function hasFilePayloadReferences(
	classification: GhClassification,
): boolean {
	return payloadReferences(classification).some(
		(reference) => reference.kind === "file",
	);
}

function payloadReferences(
	classification: GhClassification,
): PayloadReference[] {
	const argv = classification.signatureInput.argv;
	const fileFlags = fileValueFlags(classification);
	const inlineFlags = inlineValueFlags(classification);
	const references: PayloadReference[] = [];

	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index] ?? "";
		const next = argv[index + 1];

		const fileValue = flagValue(token, next, fileFlags);
		if (fileValue) {
			references.push(fileReference(fileValue.flag, fileValue.value));
			index += fileValue.consumesNext ? 1 : 0;
			continue;
		}

		const inlineValue = flagValue(token, next, inlineFlags);
		if (inlineValue) {
			references.push({
				flag: inlineValue.flag,
				kind: "inline",
				value: inlineValue.value,
			});
			index += inlineValue.consumesNext ? 1 : 0;
			continue;
		}

		if (isApiInvocation(argv)) {
			const apiField = apiFieldPayloadValue(token, next);
			if (apiField) {
				references.push(
					apiFieldReference(apiField.flag, apiField.value),
				);
				index += apiField.consumesNext ? 1 : 0;
			}
		}
	}

	if (
		classification.kind === "write" &&
		classification.writeClass === "release.create"
	) {
		references.push(...releaseAssetReferences(argv));
	}

	return references;
}

function fileValueFlags(classification: GhClassification): Set<string> {
	if (isApiInvocation(classification.signatureInput.argv)) {
		return new Set(["--input"]);
	}

	if (classification.kind !== "write") {
		return new Set(["--body-file", "--notes-file"]);
	}

	if (BODY_WRITE_CLASSES.has(classification.writeClass)) {
		return new Set(["--body-file", "-F"]);
	}

	if (classification.writeClass === "release.create") {
		return new Set(["--notes-file", "-F"]);
	}

	return new Set(["--body-file", "--notes-file"]);
}

function inlineValueFlags(
	classification: GhClassification,
): Set<string> {
	if (isApiInvocation(classification.signatureInput.argv)) {
		return new Set();
	}

	if (classification.kind !== "write") {
		return new Set(["--body", "--notes"]);
	}

	if (BODY_WRITE_CLASSES.has(classification.writeClass)) {
		return new Set(["--body", "-b"]);
	}

	if (classification.writeClass === "release.create") {
		return new Set(["--notes", "-n"]);
	}

	return new Set(["--body", "--notes"]);
}

function isApiInvocation(argv: readonly string[]): boolean {
	return argv[1] === "api";
}

function flagValue(
	token: string,
	next: string | undefined,
	flags: ReadonlySet<string>,
): { consumesNext: boolean; flag: string; value: string } | null {
	for (const flag of flags) {
		if (token === flag) {
			return { consumesNext: true, flag, value: next ?? "" };
		}
		if (flag.startsWith("--")) {
			const prefix = `${flag}=`;
			if (token.startsWith(prefix)) {
				return {
					consumesNext: false,
					flag,
					value: token.slice(prefix.length),
				};
			}
			continue;
		}
		if (token.startsWith(flag) && token.length > flag.length) {
			return {
				consumesNext: false,
				flag,
				value: stripOptionalEquals(token.slice(flag.length)),
			};
		}
	}
	return null;
}

function fileReference(flag: string, path: string): PayloadReference {
	return { flag, kind: "file", path };
}

function releaseAssetReferences(
	argv: readonly string[],
): PayloadReference[] {
	const [, ...assets] = releaseCreatePositionals(argv);
	return assets.map((asset) =>
		fileReference("asset", releaseAssetPath(asset)),
	);
}

function releaseCreatePositionals(argv: readonly string[]): string[] {
	const positionals: string[] = [];
	let parseFlags = true;

	for (let index = 3; index < argv.length; index += 1) {
		const token = argv[index] ?? "";
		const next = argv[index + 1];
		if (parseFlags && token === "--") {
			parseFlags = false;
			continue;
		}
		if (parseFlags) {
			const value = flagValue(token, next, RELEASE_VALUE_FLAGS);
			if (value) {
				index += value.consumesNext ? 1 : 0;
				continue;
			}
			if (token.startsWith("-") && token !== "-") {
				continue;
			}
		}
		positionals.push(token);
	}

	return positionals;
}

function releaseAssetPath(asset: string): string {
	const hashIndex = asset.indexOf("#");
	return hashIndex >= 0 ? asset.slice(0, hashIndex) : asset;
}

function apiFieldPayloadValue(
	token: string,
	next: string | undefined,
): { consumesNext: boolean; flag: string; value: string } | null {
	if ((token === "-f" || token === "-F") && next !== undefined) {
		return { consumesNext: true, flag: token, value: next };
	}
	if (
		(token === "--field" || token === "--raw-field") &&
		next !== undefined
	) {
		return { consumesNext: true, flag: token, value: next };
	}
	if (token.startsWith("--field=")) {
		return {
			consumesNext: false,
			flag: "--field",
			value: token.slice("--field=".length),
		};
	}
	if (token.startsWith("--raw-field=")) {
		return {
			consumesNext: false,
			flag: "--raw-field",
			value: token.slice("--raw-field=".length),
		};
	}
	if (
		(token.startsWith("-f") || token.startsWith("-F")) &&
		token.length > 2
	) {
		return {
			consumesNext: false,
			flag: token.slice(0, 2),
			value: stripOptionalEquals(token.slice(2)),
		};
	}
	return null;
}

function stripOptionalEquals(value: string): string {
	return value.startsWith("=") ? value.slice(1) : value;
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
