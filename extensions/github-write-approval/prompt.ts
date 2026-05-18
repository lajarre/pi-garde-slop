import type {
	ApprovalPromptWrite,
	ApprovalSignature,
	GhWriteClass,
} from "./types.ts";

const REDACTED_INLINE_PAYLOAD = "[redacted inline payload]";
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
const INLINE_PAYLOAD_FLAGS = new Set([
	"--body",
	"--notes",
	"--field",
	"--raw-field",
	"-F",
	"-f",
]);

export function formatApprovalPrompt(
	writes: readonly ApprovalPromptWrite[],
	signature: ApprovalSignature,
): string {
	const lines = [
		"GitHub public write approval required.",
		"",
		`Batch fingerprint: ${signature.digest}`,
		`Write count: ${writes.length}`,
		"Approval is all-or-none for this exact ordered batch.",
		"",
	];

	writes.forEach((write, index) => {
		lines.push(
			`Write ${index + 1}:`,
			`- Repository: ${write.repo.nameWithOwner}`,
			`- Visibility: ${write.repo.visibility}`,
			`- Viewer permission: ${write.repo.viewerPermission || "unknown"}`,
			`- Fork: ${forkStatus(write)}`,
			`- Reason: ${write.publicReason}`,
			`- Mutation: ${write.classification.writeClass}`,
			`- Command: ${displaySafeCommand(write)}`,
			`- Fingerprint: ${write.fingerprint}`,
			`- Payload: ${write.payload.displaySummary}`,
			`- Target: ${targetIdentity(write.classification.writeClass, write.classification.signatureInput.argv, write.target.repo)}`,
			"- Validation advice:",
		);
		for (const advice of validationAdvice(write)) {
			lines.push(`  - ${advice}`);
		}
		lines.push("");
	});

	return lines.join("\n").trimEnd();
}

export function noUiGuidance(): string {
	return [
		"Public GitHub writes require interactive approval, but this session has no UI.",
		"Prepare reviewable local drafts under `.tmp/`, such as `.tmp/body.md`, `.tmp/notes.md`, or `.tmp/payload.json`.",
		"Use `--body-file` for PR, issue, comment, and review text, and use `--notes-file` for release notes.",
		"Prefer `gh api --input file.json` for API payloads so the local JSON file can be reviewed and hashed.",
		"Record the exact `gh` command for manual review; `gh pr create --dry-run` is not a safety signal because it may still push.",
	].join(" ");
}

function forkStatus(write: ApprovalPromptWrite): string {
	if (!write.repo.isFork) {
		return "not a fork";
	}
	const parent = write.repo.parent;
	if (!parent) {
		return "fork; parent unknown";
	}
	return `fork of ${parent.nameWithOwner} (${parent.visibility ?? (parent.isPrivate ? "PRIVATE" : "PUBLIC")})`;
}

function validationAdvice(write: ApprovalPromptWrite): string[] {
	const advice = [...write.classification.validationAdvice];
	const argv = write.classification.signatureInput.argv;

	if (hasFlag(argv, "--body-file")) {
		advice.push(
			"For --body-file, review the referenced local file contents and compare them with the payload digest.",
		);
	}
	if (hasFlag(argv, "--notes-file")) {
		advice.push(
			"For --notes-file, review the release notes file contents and compare them with the payload digest.",
		);
	}
	if (
		write.classification.writeClass.startsWith("api.") &&
		hasFlag(argv, "--input")
	) {
		advice.push(
			"For gh api --input file.json, review the local JSON payload and compare it with the payload digest.",
		);
	}
	if (advice.length === 0) {
		advice.push(
			"Review the resolved repo, target, command, and payload digest before approving.",
		);
	}

	return [...new Set(advice)];
}

function displaySafeCommand(write: ApprovalPromptWrite): string {
	const tokens = [
		...write.classification.signatureInput.assignments,
		...redactedArgv(write.classification.signatureInput.argv),
	];
	return tokens.map(shellQuote).join(" ");
}

function redactedArgv(argv: readonly string[]): string[] {
	const result: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index] ?? "";
		const shortPayload = concatenatedShortPayloadFlag(token);
		if (shortPayload) {
			result.push(shortPayload.flag, REDACTED_INLINE_PAYLOAD);
			continue;
		}
		const equalsPayload = equalsPayloadFlag(token);
		if (equalsPayload) {
			result.push(`${equalsPayload.flag}=${REDACTED_INLINE_PAYLOAD}`);
			continue;
		}
		if (INLINE_PAYLOAD_FLAGS.has(token) && token !== "--input") {
			result.push(token, REDACTED_INLINE_PAYLOAD);
			index += 1;
			continue;
		}
		result.push(token);
	}
	return result;
}

function equalsPayloadFlag(token: string): { flag: string } | null {
	for (const flag of INLINE_PAYLOAD_FLAGS) {
		const prefix = `${flag}=`;
		if (token.startsWith(prefix)) {
			return { flag };
		}
	}
	return null;
}

function concatenatedShortPayloadFlag(
	token: string,
): { flag: string } | null {
	for (const flag of ["-F", "-f"]) {
		if (token.startsWith(flag) && token.length > flag.length) {
			return { flag };
		}
	}
	return null;
}

function targetIdentity(
	writeClass: GhWriteClass,
	argv: readonly string[],
	repo: string,
): string {
	const group = argv[1] ?? "";
	const subcommand = argv[2] ?? "";

	if (group === "api") {
		return `api:${apiEndpoint(argv) ?? "<unknown>"}`;
	}
	if (group === "repo") {
		return `repo:${repo}`;
	}

	const positional = firstPositionalAfterSubcommand(argv);
	return positional
		? `${writeClass}:${positional}`
		: `${group}.${subcommand}:${repo}`;
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

function hasFlag(argv: readonly string[], flag: string): boolean {
	return (
		argv.includes(flag) ||
		argv.some((token) => token.startsWith(`${flag}=`))
	);
}

function shellQuote(token: string): string {
	if (token === REDACTED_INLINE_PAYLOAD) {
		return token;
	}
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(token)) {
		return token;
	}
	return token === "" ? "''" : `'${token.replaceAll("'", "'\\''")}'`;
}
