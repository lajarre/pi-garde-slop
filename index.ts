import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallBlockResult,
	ToolCallEvent,
	ToolCallResult,
} from "@mariozechner/pi-coding-agent";
import {
	type ApprovalSignatureStore,
	createApprovalSignatureStore,
} from "./approval.ts";
import { extractGhInvocations } from "./ast.ts";
import { classifyGhInvocation } from "./classify.ts";
import { resolvePayloadIdentity } from "./payload.ts";
import { evaluateBatchPolicy } from "./policy.ts";
import { formatApprovalPrompt } from "./prompt.ts";
import {
	createRepoMetadataCache,
	type RepoExec,
	type RepoMetadataCache,
	resolveRepoForGhWrite,
} from "./repo.ts";
import type {
	GhClassification,
	PayloadFileReader,
	PayloadFileReadResult,
	PolicyDecision,
	PolicyEvaluationInput,
	RepoExecResult,
} from "./types.ts";

export interface GithubWriteApprovalAdapters {
	readFile?: PayloadFileReader;
}

type ExtensionWithExec = ExtensionAPI & {
	exec?: RepoExec;
};

export default function githubWriteApproval(
	pi: ExtensionAPI,
	adapters: GithubWriteApprovalAdapters = {},
): void {
	const approvedSignatures = createApprovalSignatureStore();
	const repoCache = createRepoMetadataCache();

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") {
			return undefined;
		}

		return await evaluateBashToolCall(event, ctx, {
			approvedSignatures,
			pi: pi as ExtensionWithExec,
			readFile: adapters.readFile ?? defaultReadFile(ctx.cwd),
			repoCache,
		});
	});
}

interface EvaluationState {
	approvedSignatures: ApprovalSignatureStore;
	pi: ExtensionWithExec;
	readFile: PayloadFileReader;
	repoCache: RepoMetadataCache;
}

async function evaluateBashToolCall(
	event: ToolCallEvent,
	ctx: ExtensionContext,
	state: EvaluationState,
): Promise<ToolCallResult> {
	const command =
		typeof event.input.command === "string" ? event.input.command : "";
	if (!command) {
		return undefined;
	}

	const extraction = extractGhInvocations(command);
	if (extraction.kind === "ambiguous") {
		return block(
			`ambiguous GitHub command: ${extraction.reason}\n\n${extraction.guidance}`,
		);
	}
	if (extraction.invocations.length === 0) {
		return undefined;
	}

	const policyInputs: PolicyEvaluationInput[] = [];
	for (const invocation of extraction.invocations) {
		const classification = classifyGhInvocation(invocation);
		const input = await policyInputForClassification(
			classification,
			ctx,
			state,
		);
		if (isBlockResult(input)) {
			return input;
		}
		policyInputs.push(input);
	}

	return await resultForPolicyDecision(
		evaluateBatchPolicy(policyInputs, { hasUI: ctx.hasUI }),
		ctx,
		state.approvedSignatures,
	);
}

async function policyInputForClassification(
	classification: GhClassification,
	ctx: ExtensionContext,
	state: EvaluationState,
): Promise<PolicyEvaluationInput | ToolCallBlockResult> {
	if (classification.kind !== "write") {
		return { classification };
	}

	const exec = state.pi.exec;
	if (!exec) {
		return block(
			"GitHub write blocked because repository metadata lookup is unavailable.\n\nRerun in a Pi runtime that exposes pi.exec so `gh repo view owner/repo --json ...` can be checked before approval.",
		);
	}

	const repoResolution = await resolveRepoForGhWrite(classification, {
		cache: state.repoCache,
		cwd: ctx.cwd,
		exec: repoExecAdapter(exec),
	});
	if (repoResolution.kind !== "resolved") {
		return { classification, repoResolution };
	}

	const payloadResult = await resolvePayloadIdentity(classification, {
		readFile: state.readFile,
	});
	if (payloadResult.kind === "blocked") {
		return block(
			`${payloadResult.reason}\n\n${payloadResult.guidance}`,
		);
	}

	return {
		classification,
		payload: payloadResult.identity,
		repo: repoResolution.metadata,
		repoResolution,
		target: repoResolution.target,
	};
}

async function resultForPolicyDecision(
	decision: PolicyDecision,
	ctx: ExtensionContext,
	approvedSignatures: ApprovalSignatureStore,
): Promise<ToolCallResult> {
	if (decision.kind === "allow") {
		return undefined;
	}
	if (decision.kind === "block") {
		return block(`${decision.reason}\n\n${decision.guidance}`);
	}
	if (approvedSignatures.has(decision.signature)) {
		return undefined;
	}
	if (!ctx.hasUI || !ctx.ui?.confirm) {
		return block(
			"public GitHub write blocked because no UI is available for approval",
		);
	}

	const approved = await ctx.ui.confirm(
		"GitHub public write approval",
		formatApprovalPrompt(decision.publicWrites, decision.signature),
	);
	if (!approved) {
		return block("GitHub public write approval denied by user");
	}

	approvedSignatures.remember(decision.signature);
	return undefined;
}

function defaultReadFile(cwd: string): PayloadFileReader {
	return async (path: string): Promise<PayloadFileReadResult> =>
		await readFile(resolve(cwd, path));
}

function repoExecAdapter(exec: RepoExec): RepoExec {
	return async (command, args, options): Promise<RepoExecResult> =>
		await exec(command, args, options);
}

function isBlockResult(
	value: PolicyEvaluationInput | ToolCallBlockResult,
): value is ToolCallBlockResult {
	return (value as ToolCallBlockResult).block === true;
}

function block(reason: string): ToolCallBlockResult {
	return { block: true, reason };
}
