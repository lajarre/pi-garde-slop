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
