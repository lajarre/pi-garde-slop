export interface GhInvocation {
	assignments: string[];
	argv: string[];
	shellPrefix?: GhInvocationShellPrefix;
}

export interface GhInvocationShellPrefix {
	nonGhCommand?: true;
	priorCommand?: true;
	stateChange?: true;
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

export type PayloadSourceKind = "file" | "inline";

export interface PayloadPartIdentity {
	digest: string;
	flag: string;
	kind: PayloadSourceKind;
	path?: string;
}

export interface PayloadIdentity {
	digest: string;
	digestAlgorithm: "sha256";
	displaySummary: string;
	parts: PayloadPartIdentity[];
}

export interface PayloadIdentityResolved {
	identity: PayloadIdentity;
	kind: "resolved";
}

export interface PayloadIdentityBlocked {
	guidance: string;
	kind: "blocked";
	reason: string;
}

export type PayloadIdentityResult =
	| PayloadIdentityResolved
	| PayloadIdentityBlocked;

export type PayloadFileReadResult = string | Buffer | Uint8Array;

export type PayloadFileReader = (
	path: string,
) => Promise<PayloadFileReadResult> | PayloadFileReadResult;

export interface ApprovalWriteInput {
	classification: WriteGhClassification;
	payload: PayloadIdentity;
	repo: RepoMetadata;
	target: ResolvedRepoTarget;
}

export interface ApprovalSignature {
	digest: string;
	displaySummary: string;
	kind: "batch" | "single";
	writeCount: number;
}

export interface ApprovalSignatureStore {
	has(signature: ApprovalSignature): boolean;
	remember(signature: ApprovalSignature): void;
}

export interface PolicyEvaluationOptions {
	hasUI: boolean;
}

export interface PolicyEvaluationInput {
	classification: GhClassification;
	payload?: PayloadIdentity;
	repo?: RepoMetadata;
	repoResolution?: RepoResolutionResult;
	target?: ResolvedRepoTarget;
}

export interface ApprovalPromptWrite extends ApprovalWriteInput {
	fingerprint: string;
	publicReason: string;
}

export interface PolicyAllowDecision {
	kind: "allow";
	reason: string;
}

export interface PolicyBlockDecision {
	guidance: string;
	kind: "block";
	reason: string;
}

export interface PolicyPromptDecision {
	kind: "prompt";
	publicWrites: ApprovalPromptWrite[];
	reason: string;
	signature: ApprovalSignature;
}

export type PolicyDecision =
	| PolicyAllowDecision
	| PolicyBlockDecision
	| PolicyPromptDecision;
