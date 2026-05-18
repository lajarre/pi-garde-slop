import type {
	GhClassification,
	GhTargetHint,
	GhTargetHintSource,
	RepoExec,
	RepoExecResult,
	RepoMetadata,
	RepoMetadataCache,
	RepoMetadataParent,
	RepoResolutionResult,
	ResolvedRepoTarget,
} from "./types.ts";

export type {
	RepoExec,
	RepoExecResult,
	RepoMetadata,
	RepoMetadataCache,
	RepoMetadataParent,
	RepoResolutionResult,
	ResolvedRepoTarget,
} from "./types.ts";

export const REPO_METADATA_JSON_FIELDS =
	"nameWithOwner,isPrivate,visibility,isFork,parent,viewerPermission";

const EXPLICIT_SOURCE_PRECEDENCE: GhTargetHintSource[] = [
	"repoFlag",
	"positionalRepo",
	"restPath",
	"ghRepoAssignment",
];

const METADATA_TIMEOUT_MS = 10_000;
const GIT_REMOTE_TIMEOUT_MS = 3_000;

export interface ResolveRepoOptions {
	cache?: RepoMetadataCache;
	cwd: string;
	exec: RepoExec;
	metadataTimeoutMs?: number;
	remoteTimeoutMs?: number;
}

export function createRepoMetadataCache(): RepoMetadataCache {
	return new Map<string, RepoMetadata>();
}

export async function resolveRepoForGhWrite(
	classification: GhClassification,
	options: ResolveRepoOptions,
): Promise<RepoResolutionResult> {
	const cache = options.cache ?? createRepoMetadataCache();
	const explicitTargets = explicitTargetsFromHints(
		classification.targetHints,
	);
	const conflict = conflictResult(explicitTargets);
	if (conflict) {
		return conflict;
	}

	const explicitTarget = explicitTargets[0] ?? null;
	const target = explicitTarget ?? (await cwdRemoteTarget(options));
	if (!target) {
		return unresolvedResult();
	}

	return await resolveTargetMetadata(target, cache, options);
}

export function extractGitHubRepoFromRemoteUrl(
	remoteUrl: string,
): string | null {
	const trimmed = remoteUrl.trim();
	if (!trimmed) {
		return null;
	}

	const parsedUrl = parseGitHubUrlPath(trimmed);
	if (parsedUrl) {
		return parsedUrl;
	}

	const scpLikeMatch =
		/^(?:[^@\s]+@)?github\.com:(?<path>[^\s]+)$/.exec(trimmed);
	if (!scpLikeMatch?.groups?.path) {
		return null;
	}

	return ownerRepoFromPath(scpLikeMatch.groups.path);
}

function parseGitHubUrlPath(value: string): string | null {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}

	if (url.hostname.toLowerCase() !== "github.com") {
		return null;
	}

	return ownerRepoFromPath(url.pathname);
}

function ownerRepoFromPath(pathValue: string): string | null {
	const cleanPath = pathValue
		.trim()
		.replace(/^\/+/, "")
		.replace(/\/+$/, "")
		.replace(/\.git$/, "");
	const [owner, repo, ...extra] = cleanPath.split("/");

	if (!owner || !repo || extra.length > 0) {
		return null;
	}

	const nameWithOwner = `${owner}/${repo}`;
	return isOwnerRepo(nameWithOwner) ? nameWithOwner : null;
}

function explicitTargetsFromHints(
	hints: readonly GhTargetHint[],
): ResolvedRepoTarget[] {
	const targets: ResolvedRepoTarget[] = [];
	const seen = new Set<string>();

	for (const source of EXPLICIT_SOURCE_PRECEDENCE) {
		for (const hint of hints) {
			if (hint.source !== source || !isOwnerRepo(hint.repo)) {
				continue;
			}

			const key = `${source}\0${hint.repo}`;
			if (seen.has(key)) {
				continue;
			}

			seen.add(key);
			targets.push({ repo: hint.repo, source });
		}
	}

	return targets;
}

function conflictResult(
	targets: readonly ResolvedRepoTarget[],
): RepoResolutionResult | null {
	if (targets.length < 2) {
		return null;
	}

	const repos = new Set(targets.map((target) => target.repo));
	if (repos.size <= 1) {
		return null;
	}

	return {
		guidance:
			"rewrite the command with a single explicit repo target, for example `-R owner/repo`, and remove conflicting repo hints",
		kind: "conflict",
		reason: `conflicting explicit repo targets: ${targets
			.map((target) => `${target.source}=${target.repo}`)
			.join(", ")}`,
		sources: [...targets],
	};
}

async function cwdRemoteTarget(
	options: ResolveRepoOptions,
): Promise<ResolvedRepoTarget | null> {
	let result: RepoExecResult;
	try {
		result = await options.exec(
			"git",
			["remote", "get-url", "origin"],
			{
				cwd: options.cwd,
				timeout: options.remoteTimeoutMs ?? GIT_REMOTE_TIMEOUT_MS,
			},
		);
	} catch {
		return null;
	}

	if (execExitCode(result) !== 0) {
		return null;
	}

	const repo = extractGitHubRepoFromRemoteUrl(result.stdout ?? "");
	return repo ? { repo, source: "cwdRemote" } : null;
}

async function resolveTargetMetadata(
	target: ResolvedRepoTarget,
	cache: RepoMetadataCache,
	options: ResolveRepoOptions,
): Promise<RepoResolutionResult> {
	const cached = cache.get(target.repo);
	if (cached) {
		return { kind: "resolved", metadata: cached, target };
	}

	let result: RepoExecResult;
	try {
		result = await options.exec(
			"gh",
			[
				"repo",
				"view",
				target.repo,
				"--json",
				REPO_METADATA_JSON_FIELDS,
			],
			{
				cwd: options.cwd,
				timeout: options.metadataTimeoutMs ?? METADATA_TIMEOUT_MS,
			},
		);
	} catch (error) {
		return metadataErrorResult(target, errorMessage(error));
	}

	if (execExitCode(result) !== 0) {
		return metadataErrorResult(
			target,
			result.stderr?.trim() || `gh repo view failed for ${target.repo}`,
		);
	}

	const parsed = parseMetadata(result.stdout ?? "");
	if (!parsed) {
		return metadataErrorResult(
			target,
			`gh repo view returned invalid metadata for ${target.repo}`,
		);
	}

	cache.set(parsed.nameWithOwner, parsed);
	return { kind: "resolved", metadata: parsed, target };
}

function parseMetadata(stdout: string): RepoMetadata | null {
	let raw: unknown;
	try {
		raw = JSON.parse(stdout);
	} catch {
		return null;
	}

	if (!raw || typeof raw !== "object") {
		return null;
	}

	const value = raw as Record<string, unknown>;
	const nameWithOwner = stringValue(value.nameWithOwner);
	if (!nameWithOwner || !isOwnerRepo(nameWithOwner)) {
		return null;
	}

	return {
		isFork: booleanValue(value.isFork),
		isPrivate: booleanValue(value.isPrivate),
		nameWithOwner,
		parent: parseParentMetadata(value.parent),
		viewerPermission: stringValue(value.viewerPermission) ?? "",
		visibility:
			stringValue(value.visibility) ??
			(booleanValue(value.isPrivate) ? "PRIVATE" : "PUBLIC"),
	};
}

function parseParentMetadata(
	value: unknown,
): RepoMetadataParent | null {
	if (!value || typeof value !== "object") {
		return null;
	}

	const parent = value as Record<string, unknown>;
	const nameWithOwner = stringValue(parent.nameWithOwner);
	if (!nameWithOwner || !isOwnerRepo(nameWithOwner)) {
		return null;
	}

	return {
		isPrivate:
			typeof parent.isPrivate === "boolean"
				? parent.isPrivate
				: undefined,
		nameWithOwner,
		visibility: stringValue(parent.visibility),
	};
}

function metadataErrorResult(
	target: ResolvedRepoTarget,
	reason: string,
): RepoResolutionResult {
	return {
		guidance:
			"manual review required: verify the repository exists and rerun with an explicit reviewable repo target",
		kind: "metadataError",
		reason,
		target,
	};
}

function unresolvedResult(): RepoResolutionResult {
	return {
		guidance:
			"rewrite the command with `-R owner/repo` or `GH_REPO=owner/repo` so the GitHub write target can be reviewed",
		kind: "unresolved",
		reason:
			"unable to resolve GitHub repo target from explicit flags, positional args, REST path, GH_REPO, or cwd remote",
	};
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function booleanValue(value: unknown): boolean {
	return typeof value === "boolean" ? value : false;
}

function execExitCode(result: RepoExecResult): number {
	if (typeof result.exitCode === "number") {
		return result.exitCode;
	}
	if (typeof result.code === "number") {
		return result.code;
	}
	return 0;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isOwnerRepo(value: string): boolean {
	return /^[^/\s]+\/[^/\s]+$/.test(value);
}
