import type {
	GhClassification,
	GhClassificationBase,
	GhInvocation,
	GhTargetHint,
	GhTargetHintSource,
	GhWriteClass,
} from "./types.ts";

type CommandConfig = {
	readOnly?: string;
	unsupported?: Readonly<Record<string, string>>;
	write?: string;
};

type ApiInfo = {
	endpoint?: string;
	fields: string[];
	inputValues: string[];
	method: string | null;
};

const GIST_UNSUPPORTED_REASON =
	"gist writes are not repo-scoped and are not approved in v1";

const COMMAND_TABLE: Readonly<Record<string, CommandConfig>> = {
	gist: {
		readOnly: "list view",
		unsupported: {
			create: GIST_UNSUPPORTED_REASON,
			delete: GIST_UNSUPPORTED_REASON,
			edit: GIST_UNSUPPORTED_REASON,
		},
	},
	issue: {
		readOnly: "list status view",
		write:
			"close comment create delete edit lock reopen transfer unlock",
	},
	label: { readOnly: "list", write: "create delete edit" },
	pr: {
		readOnly: "checks checkout diff list status view",
		write:
			"close comment create edit lock merge ready reopen revert review unlock update-branch",
	},
	release: { readOnly: "download list view", write: "create" },
	repo: {
		readOnly: "list view",
		unsupported: {
			create:
				"repo creation targets a not-yet-existing repo and is not approved in v1",
		},
		write: "archive delete edit rename unarchive",
	},
	secret: { readOnly: "list", write: "set" },
	variable: { readOnly: "list", write: "set" },
	workflow: { readOnly: "list view", write: "run" },
};

const API_VALUE_FLAGS =
	"--cache --field --header --hostname --input --jq --method --preview --raw-field --template -F -H -X -f";
const API_WRITE_METHODS = "DELETE PATCH POST PUT";
const API_DESTRUCTIVE_GRAPHQL_METHODS = "DELETE PATCH PUT";
const BODY_WRITE_CLASSES =
	"issue.comment issue.create pr.comment pr.create pr.review";

const CLASS_ADVICE: Readonly<Record<string, readonly string[]>> = {
	"pr.create": [
		"For gh pr create, --dry-run is not trusted as safe because it may still push; prefer an explicitly pushed branch and review local diff/stat.",
	],
	"pr.merge": ["For gh pr merge, prefer --match-head-commit."],
	"release.create": [
		"For gh release create, prefer --verify-tag.",
		"For release notes, prefer --notes-file.",
	],
};

export function classifyGhInvocation(
	invocation: GhInvocation,
): GhClassification {
	const base = classificationBase(invocation);
	const [commandWord, group, subcommand] = invocation.argv;

	if (!commandWord || commandBaseName(commandWord) !== "gh") {
		return ambiguous(base, "invocation command word is not gh");
	}
	if (!group) {
		return ambiguous(base, "missing gh command group");
	}
	if (group === "api") {
		return classifyApiInvocation(invocation, base);
	}

	const command = COMMAND_TABLE[group];
	if (!command) {
		return ambiguous(base, `unknown gh command group: ${group}`);
	}
	if (!subcommand) {
		return ambiguous(base, `missing gh ${group} subcommand`);
	}
	if (hasWord(command.readOnly, subcommand)) {
		return { ...base, kind: "readOnly" };
	}

	const unsupportedReason = command.unsupported?.[subcommand];
	if (unsupportedReason) {
		return unsupportedWrite(
			base,
			commandWriteClass(group, subcommand),
			unsupportedReason,
			invocation.argv,
		);
	}
	if (hasWord(command.write, subcommand)) {
		return writeClassification(
			base,
			commandWriteClass(group, subcommand),
			invocation.argv,
		);
	}

	return ambiguous(
		base,
		`unknown gh ${group} subcommand: ${subcommand}`,
	);
}

function classifyApiInvocation(
	invocation: GhInvocation,
	base: GhClassificationBase,
): GhClassification {
	const info = apiInfo(invocation.argv);
	const endpoint = info.endpoint?.replace(/^\/+/, "") ?? "";
	const isGraphqlEndpoint = endpoint === "graphql";
	const hasGraphqlMutation =
		isGraphqlEndpoint && info.fields.some(fieldIsGraphqlMutation);
	const hasUninspectableGraphqlPayload =
		isGraphqlEndpoint && graphqlPayloadCanHideMutation(info);
	const apiAdvice = adviceForWrite("api.post", invocation.argv);

	if (hasGraphqlMutation) {
		return unsupportedWrite(
			base,
			"api.graphql.mutation",
			"repo-less gh api GraphQL mutation is not approved in v1",
			invocation.argv,
			apiAdvice,
		);
	}
	if (isGraphqlEndpoint) {
		if (
			info.method &&
			hasWord(API_DESTRUCTIVE_GRAPHQL_METHODS, info.method)
		) {
			return unsupportedWrite(
				base,
				apiWriteClass(info.method),
				"repo-less gh api GraphQL write method is not approved in v1",
				invocation.argv,
			);
		}
		if (hasUninspectableGraphqlPayload) {
			return unsupportedWrite(
				base,
				"api.graphql.mutation",
				"file-backed or uninspectable gh api GraphQL payload may contain a mutation",
				invocation.argv,
				apiAdvice,
			);
		}
		return { ...base, kind: "readOnly" };
	}

	const writeMethod =
		info.method && hasWord(API_WRITE_METHODS, info.method)
			? info.method
			: null;
	const effectiveMethod =
		writeMethod ??
		(!info.method && info.fields.length > 0 ? "POST" : null);
	if (!effectiveMethod) {
		return { ...base, kind: "readOnly" };
	}

	const writeClass = apiWriteClass(effectiveMethod);
	const validationAdvice = adviceForWrite(writeClass, invocation.argv);
	if (!base.targetHints.some((hint) => hint.source === "restPath")) {
		return unsupportedWrite(
			base,
			writeClass,
			"non-repo-scoped gh api write is not approved in v1",
			invocation.argv,
			validationAdvice,
		);
	}
	return writeClassification(
		base,
		writeClass,
		invocation.argv,
		validationAdvice,
	);
}

function classificationBase(
	invocation: GhInvocation,
): GhClassificationBase {
	const signatureInput: GhInvocation = {
		assignments: [...invocation.assignments],
		argv: [...invocation.argv],
	};
	return {
		normalizedCommand: normalizeInvocation(signatureInput),
		signatureInput,
		targetHints: collectTargetHints(signatureInput),
		validationAdvice: [],
	};
}

function ambiguous(
	base: GhClassificationBase,
	reason: string,
): GhClassification {
	return {
		...base,
		guidance:
			"manual review required: rewrite as an explicit supported gh command with literal arguments and an explicit repo target",
		kind: "ambiguous",
		reason,
	};
}

function unsupportedWrite(
	base: GhClassificationBase,
	writeClass: GhWriteClass,
	reason: string,
	argv: readonly string[],
	validationAdvice = adviceForWrite(writeClass, argv),
): GhClassification {
	return {
		...base,
		kind: "unsupportedWrite",
		reason,
		validationAdvice,
		writeClass,
	};
}

function writeClassification(
	base: GhClassificationBase,
	writeClass: GhWriteClass,
	argv: readonly string[],
	validationAdvice = adviceForWrite(writeClass, argv),
): GhClassification {
	return { ...base, kind: "write", validationAdvice, writeClass };
}

function commandWriteClass(
	group: string,
	subcommand: string,
): GhWriteClass {
	return `${group}.${subcommand}` as GhWriteClass;
}

function apiWriteClass(method: string): GhWriteClass {
	return `api.${method.toLowerCase()}` as GhWriteClass;
}

function normalizeInvocation(invocation: GhInvocation): string {
	return [...invocation.assignments, ...invocation.argv]
		.map((token) => shellQuote(token))
		.join(" ");
}

function shellQuote(token: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(token)) {
		return token;
	}
	return token === "" ? "''" : `'${token.replaceAll("'", "'\\''")}'`;
}

function commandBaseName(value: string): string {
	const normalized = value.replace(/\\+/g, "/");
	const index = normalized.lastIndexOf("/");
	return (
		index >= 0 ? normalized.slice(index + 1) : normalized
	).toLowerCase();
}

function collectTargetHints(invocation: GhInvocation): GhTargetHint[] {
	const hints: GhTargetHint[] = [];
	for (const assignment of invocation.assignments) {
		const repo = assignmentValue(assignment, "GH_REPO");
		if (repo) {
			addHint(hints, "ghRepoAssignment", repo);
		}
	}
	for (const repo of repoFlagValues(invocation.argv)) {
		addHint(hints, "repoFlag", repo);
	}

	const positionalRepo = positionalRepoTarget(invocation.argv);
	const restRepo = restPathRepoTarget(
		apiInfo(invocation.argv).endpoint,
	);
	if (positionalRepo) {
		addHint(hints, "positionalRepo", positionalRepo);
	}
	if (restRepo) {
		addHint(hints, "restPath", restRepo);
	}
	return hints;
}

function assignmentValue(
	assignment: string,
	name: string,
): string | null {
	const prefix = `${name}=`;
	return assignment.startsWith(prefix)
		? assignment.slice(prefix.length)
		: null;
}

function addHint(
	hints: GhTargetHint[],
	source: GhTargetHintSource,
	repo: string,
): void {
	if (
		!isRepoName(repo) ||
		hints.some((hint) => hint.source === source && hint.repo === repo)
	) {
		return;
	}
	hints.push({ source, repo });
}

function isRepoName(value: string): boolean {
	return /^[^/\s]+\/[^/\s]+$/.test(value);
}

function repoFlagValues(argv: string[]): string[] {
	const values: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index] ?? "";
		if ((token === "-R" || token === "--repo") && argv[index + 1]) {
			values.push(argv[index + 1] ?? "");
			index += 1;
			continue;
		}
		if (token.startsWith("--repo=")) {
			values.push(token.slice("--repo=".length));
			continue;
		}
		if (token.startsWith("-R") && token.length > 2) {
			values.push(stripOptionalEquals(token.slice(2)));
		}
	}
	return values;
}

function stripOptionalEquals(value: string): string {
	return value.startsWith("=") ? value.slice(1) : value;
}

function positionalRepoTarget(argv: string[]): string | null {
	const candidate = argv[1] === "repo" ? argv[3] : null;
	return candidate && isRepoName(candidate) ? candidate : null;
}

function restPathRepoTarget(
	endpoint: string | undefined,
): string | null {
	const match = endpoint
		? /^\/?repos\/([^/\s]+)\/([^/\s]+)(?:\/|$)/.exec(endpoint)
		: null;
	return match ? `${match[1]}/${match[2]}` : null;
}

function apiInfo(argv: string[]): ApiInfo {
	const info: ApiInfo = {
		fields: [],
		inputValues: [],
		method: null,
	};
	if (argv[1] !== "api") {
		return info;
	}
	for (let index = 2; index < argv.length; index += 1) {
		const token = argv[index] ?? "";
		const next = argv[index + 1];

		if (token === "--") {
			info.endpoint ??= next;
			break;
		}
		if ((token === "-X" || token === "--method") && next) {
			info.method = normalizeMethod(next);
			index += 1;
			continue;
		}
		if (token.startsWith("--method=")) {
			info.method = normalizeMethod(token.slice("--method=".length));
			continue;
		}
		if (token.startsWith("-X") && token.length > 2) {
			info.method = normalizeMethod(
				stripOptionalEquals(token.slice(2)),
			);
			continue;
		}

		const input = apiInputValue(token, next);
		if (input) {
			info.inputValues.push(input.value);
			index += input.consumesNext ? 1 : 0;
			continue;
		}

		const field = apiFieldValue(token, next);
		if (field) {
			info.fields.push(field.value);
			index += field.consumesNext ? 1 : 0;
			continue;
		}
		if (apiFlagConsumesNext(token) && next) {
			index += 1;
			continue;
		}
		if (!info.endpoint && (!token.startsWith("-") || token === "-")) {
			info.endpoint = token;
		}
	}
	return info;
}

function apiFlagConsumesNext(token: string): boolean {
	return hasWord(API_VALUE_FLAGS, token) || /^-[fFXH]$/.test(token);
}

function apiInputValue(
	token: string,
	next: string | undefined,
): { consumesNext: boolean; value: string } | null {
	if (token === "--input" && next !== undefined) {
		return { consumesNext: true, value: next };
	}
	if (token.startsWith("--input=")) {
		return {
			consumesNext: false,
			value: token.slice("--input=".length),
		};
	}
	return null;
}

function apiFieldValue(
	token: string,
	next: string | undefined,
): { consumesNext: boolean; value: string } | null {
	if ((token === "-f" || token === "-F") && next !== undefined) {
		return { consumesNext: true, value: next };
	}
	if (
		(token === "--field" || token === "--raw-field") &&
		next !== undefined
	) {
		return { consumesNext: true, value: next };
	}
	if (token.startsWith("--field=")) {
		return {
			consumesNext: false,
			value: token.slice("--field=".length),
		};
	}
	if (token.startsWith("--raw-field=")) {
		return {
			consumesNext: false,
			value: token.slice("--raw-field=".length),
		};
	}
	if (
		(token.startsWith("-f") || token.startsWith("-F")) &&
		token.length > 2
	) {
		return {
			consumesNext: false,
			value: stripOptionalEquals(token.slice(2)),
		};
	}
	return null;
}

function normalizeMethod(method: string): string {
	return method.toUpperCase();
}

function fieldIsGraphqlMutation(field: string): boolean {
	const separator = field.indexOf("=");
	if (separator < 0 || field.slice(0, separator) !== "query") {
		return false;
	}
	return /(^|\s)mutation\b/i.test(field.slice(separator + 1));
}

function graphqlPayloadCanHideMutation(info: ApiInfo): boolean {
	return (
		info.inputValues.length > 0 ||
		info.fields.some(fieldIsGraphqlFileBackedQuery)
	);
}

function fieldIsGraphqlFileBackedQuery(field: string): boolean {
	const separator = field.indexOf("=");
	if (separator < 0 || field.slice(0, separator) !== "query") {
		return false;
	}
	return field
		.slice(separator + 1)
		.trimStart()
		.startsWith("@");
}

function adviceForWrite(
	writeClass: GhWriteClass,
	argv: readonly string[],
): string[] {
	const advice = [...(CLASS_ADVICE[writeClass] ?? [])];
	if (writeClass.startsWith("api.")) {
		advice.push(
			"For gh api writes, prefer --input file.json for reviewable payloads; opaque stdin is blocked.",
		);
	}
	if (usesInlineBody(argv) || hasWord(BODY_WRITE_CLASSES, writeClass)) {
		advice.push("For body/comment/review text, prefer --body-file.");
	}
	return advice;
}

function usesInlineBody(argv: readonly string[]): boolean {
	return (
		argv.includes("--body") ||
		argv.some((arg) => arg.startsWith("--body="))
	);
}

function hasWord(words: string | undefined, value: string): boolean {
	return words?.split(/\s+/).includes(value) ?? false;
}
