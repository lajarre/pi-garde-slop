import { buildApprovalSignature } from "./approval.ts";
import { noUiGuidance } from "./prompt.ts";
import type {
	ApprovalPromptWrite,
	ApprovalWriteInput,
	GhClassification,
	PolicyDecision,
	PolicyEvaluationInput,
	PolicyEvaluationOptions,
	RepoMetadata,
	RepoResolutionResult,
	ResolvedRepoTarget,
	WriteGhClassification,
} from "./types.ts";

export function evaluateBatchPolicy(
	items: readonly PolicyEvaluationInput[],
	options: PolicyEvaluationOptions,
): PolicyDecision {
	const publicWrites: ApprovalPromptWrite[] = [];
	let privateWriteCount = 0;

	for (const item of items) {
		const classificationDecision = blockingClassificationDecision(
			item.classification,
		);
		if (classificationDecision) {
			return classificationDecision;
		}
		if (item.classification.kind !== "write") {
			continue;
		}

		const resolution = resolvedRepoDecision(item.repoResolution);
		if (resolution.kind === "block") {
			return resolution;
		}

		const repo = item.repo ?? resolution.repo;
		const target = item.target ?? resolution.target;
		const publicReason = publicWriteReason(item.classification, repo);

		if (!publicReason) {
			privateWriteCount += 1;
			continue;
		}
		if (!item.payload) {
			return {
				guidance:
					"rewrite the command with deterministic payload files so content identity can be reviewed before approval",
				kind: "block",
				reason:
					"missing deterministic payload identity for public GitHub write",
			};
		}

		const write: ApprovalWriteInput = {
			classification: item.classification,
			payload: item.payload,
			repo,
			target,
		};
		publicWrites.push({
			...write,
			fingerprint: buildApprovalSignature([write]).digest,
			publicReason,
		});
	}

	if (publicWrites.length === 0) {
		return {
			kind: "allow",
			reason:
				privateWriteCount > 0
					? "all GitHub writes resolve to private repositories"
					: "no public GitHub writes require approval",
		};
	}

	if (!options.hasUI) {
		return {
			guidance: noUiGuidance(),
			kind: "block",
			reason:
				"public GitHub write blocked because no UI is available for approval",
		};
	}

	return {
		kind: "prompt",
		publicWrites,
		reason: "public GitHub write approval required",
		signature: buildApprovalSignature(publicWrites),
	};
}

function blockingClassificationDecision(
	classification: GhClassification,
): (PolicyDecision & { kind: "block" }) | null {
	if (classification.kind === "ambiguous") {
		return {
			guidance: classification.guidance,
			kind: "block",
			reason: `ambiguous GitHub write form detected: ${classification.reason}`,
		};
	}
	if (classification.kind === "unsupportedWrite") {
		return {
			guidance:
				"rewrite the command into a supported repo-scoped form or perform manual review outside the approval gate",
			kind: "block",
			reason: `unsupported GitHub write detected: ${classification.reason}; intentionally not approved in v1; rewrite or manual review required`,
		};
	}
	return null;
}

function resolvedRepoDecision(
	resolution: RepoResolutionResult | undefined,
):
	| {
			kind: "resolved";
			repo: RepoMetadata;
			target: ResolvedRepoTarget;
	  }
	| (PolicyDecision & { kind: "block" }) {
	if (!resolution) {
		return {
			guidance:
				"rewrite the command with `-R owner/repo` or `GH_REPO=owner/repo` so the GitHub write target can be reviewed",
			kind: "block",
			reason: "GitHub write has no resolved repository target",
		};
	}
	if (resolution.kind === "resolved") {
		return {
			kind: "resolved",
			repo: resolution.metadata,
			target: resolution.target,
		};
	}
	if (resolution.kind === "conflict") {
		return {
			guidance: resolution.guidance,
			kind: "block",
			reason: resolution.reason,
		};
	}
	if (resolution.kind === "metadataError") {
		return {
			guidance: resolution.guidance,
			kind: "block",
			reason: `GitHub write target did not resolve to an existing repository: ${resolution.reason}`,
		};
	}
	return {
		guidance: resolution.guidance,
		kind: "block",
		reason: resolution.reason,
	};
}

function publicWriteReason(
	classification: WriteGhClassification,
	repo: RepoMetadata,
): string | null {
	if (isPublicRepo(repo)) {
		return `public repo ${repo.nameWithOwner} requires approval`;
	}
	if (isPrWrite(classification) && hasPublicParent(repo)) {
		return `PR write against fork ${repo.nameWithOwner} whose public parent is ${repo.parent?.nameWithOwner} requires approval`;
	}
	return null;
}

function isPublicRepo(repo: RepoMetadata): boolean {
	return repo.visibility.toUpperCase() === "PUBLIC" || !repo.isPrivate;
}

function isPrWrite(classification: WriteGhClassification): boolean {
	return classification.writeClass.startsWith("pr.");
}

function hasPublicParent(repo: RepoMetadata): boolean {
	if (!repo.isFork || !repo.parent) {
		return false;
	}
	const visibility = repo.parent.visibility?.toUpperCase();
	return visibility === "PUBLIC" || repo.parent.isPrivate === false;
}
