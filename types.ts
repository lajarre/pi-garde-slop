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
