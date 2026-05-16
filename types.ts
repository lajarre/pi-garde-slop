export interface GhInvocation {
	assignments: string[];
	argv: string[];
}

export interface ReviewableExtractionResult {
	kind: "reviewable";
	invocations: GhInvocation[];
}

export interface AmbiguousExtractionResult {
	kind: "ambiguous";
	reason: string;
	guidance: string;
}

export type ExtractionResult =
	| ReviewableExtractionResult
	| AmbiguousExtractionResult;

export type GhTargetHintSource =
	| "ghRepoAssignment"
	| "positionalRepo"
	| "repoFlag"
	| "restPath";

export interface GhTargetHint {
	source: GhTargetHintSource;
	repo: string;
}

export type GhWriteClass =
	| `api.${"delete" | "patch" | "post" | "put"}`
	| "api.graphql.mutation"
	| `gist.${"create" | "delete" | "edit"}`
	| `issue.${
			| "close"
			| "comment"
			| "create"
			| "delete"
			| "edit"
			| "lock"
			| "reopen"
			| "transfer"
			| "unlock"}`
	| `label.${"create" | "delete" | "edit"}`
	| "release.create"
	| `pr.${
			| "close"
			| "comment"
			| "create"
			| "edit"
			| "lock"
			| "merge"
			| "ready"
			| "reopen"
			| "revert"
			| "review"
			| "unlock"
			| "update-branch"}`
	| `repo.${
			| "archive"
			| "create"
			| "delete"
			| "edit"
			| "rename"
			| "unarchive"}`
	| "secret.set"
	| "variable.set"
	| "workflow.run";

export interface GhClassificationBase {
	normalizedCommand: string;
	signatureInput: GhInvocation;
	targetHints: GhTargetHint[];
	validationAdvice: string[];
}

export interface ReadOnlyGhClassification extends GhClassificationBase {
	kind: "readOnly";
}

export interface WriteGhClassification extends GhClassificationBase {
	kind: "write";
	writeClass: GhWriteClass;
}

export interface UnsupportedWriteGhClassification
	extends GhClassificationBase {
	kind: "unsupportedWrite";
	reason: string;
	writeClass: GhWriteClass;
}

export interface AmbiguousGhClassification
	extends GhClassificationBase {
	kind: "ambiguous";
	guidance: string;
	reason: string;
}

export type GhClassification =
	| ReadOnlyGhClassification
	| WriteGhClassification
	| UnsupportedWriteGhClassification
	| AmbiguousGhClassification;

export type RepoTargetSource = GhTargetHintSource | "cwdRemote";

export interface ResolvedRepoTarget {
	repo: string;
	source: RepoTargetSource;
}

export interface RepoMetadataParent {
	isPrivate?: boolean;
	nameWithOwner: string;
	visibility?: string | null;
}

export interface RepoMetadata {
	isFork: boolean;
	isPrivate: boolean;
	nameWithOwner: string;
	parent: RepoMetadataParent | null;
	viewerPermission: string;
	visibility: string;
}

export type RepoMetadataCache = Map<string, RepoMetadata>;

export interface RepoExecResult {
	code?: number;
	exitCode?: number;
	stderr?: string;
	stdout?: string;
}

export type RepoExec = (
	command: string,
	args: string[],
	options?: { cwd?: string; timeout?: number },
) => Promise<RepoExecResult> | RepoExecResult;

export interface RepoResolutionResolved {
	kind: "resolved";
	metadata: RepoMetadata;
	target: ResolvedRepoTarget;
}

export interface RepoResolutionConflict {
	kind: "conflict";
	guidance: string;
	reason: string;
	sources: ResolvedRepoTarget[];
}

export interface RepoResolutionUnresolved {
	kind: "unresolved";
	guidance: string;
	reason: string;
}

export interface RepoResolutionMetadataError {
	kind: "metadataError";
	guidance: string;
	reason: string;
	target: ResolvedRepoTarget;
}

export type RepoResolutionResult =
	| RepoResolutionResolved
	| RepoResolutionConflict
	| RepoResolutionUnresolved
	| RepoResolutionMetadataError;
