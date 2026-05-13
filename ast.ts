import { createRequire } from "node:module";
import type { ExtractionResult, GhInvocation } from "./types.ts";

export type { ExtractionResult } from "./types.ts";

const require = createRequire(import.meta.url);

type ParseBash = (input: string) => unknown;

type WordToken = {
	text: string;
	literal: boolean;
	reason?: string;
};

type RedirectionToken = {
	operator: string;
	targetKind: string;
};

type UnwrappedCommand = {
	command: WordToken;
	args: WordToken[];
	assignments: string[];
};

type TraversalState = {
	invocations: GhInvocation[];
	ambiguous?: ExtractionResult;
};

type BashNode = Record<string, unknown>;
type VisitScript = (script: unknown) => void;

function asNode(value: unknown): BashNode | null {
	return value && typeof value === "object"
		? (value as BashNode)
		: null;
}

function nodeArray(value: unknown, key: string): unknown[] {
	const node = asNode(value);
	const property = node?.[key];
	return Array.isArray(property) ? property : [];
}

let parseBash: ParseBash | null | undefined;

function loadParseBash(): ParseBash | null {
	if (parseBash !== undefined) {
		return parseBash ?? null;
	}

	try {
		const module = require("just-bash") as { parse?: unknown };
		parseBash =
			typeof module.parse === "function"
				? (module.parse as ParseBash)
				: null;
	} catch {
		parseBash = null;
	}

	return parseBash;
}

function ambiguous(reason: string): ExtractionResult {
	return {
		kind: "ambiguous",
		reason,
		guidance:
			"rewrite as literal `gh ... --body-file .tmp/body.md` without command substitution, heredoc stdin, --editor, or --web",
	};
}

function commandBaseName(value: string): string {
	const normalized = value.replace(/\\+/g, "/");
	const index = normalized.lastIndexOf("/");
	const base = index >= 0 ? normalized.slice(index + 1) : normalized;
	return base.toLowerCase();
}

function riskyWhenParserUnavailable(command: string): boolean {
	return (
		/(^|[^A-Za-z0-9_-])gh([^A-Za-z0-9_-]|$)/.test(command) ||
		/[$`]|\b(alias|function|eval|source|\.)\b/.test(command)
	);
}

function literalText(text: unknown): string {
	return typeof text === "string" ? text : "";
}

function literalPartToText(part: unknown): WordToken {
	const node = asNode(part);
	if (!node) {
		return { text: "", literal: false, reason: "unknown word part" };
	}

	switch (node.type) {
		case "Literal":
		case "SingleQuoted":
		case "Escaped":
			return { text: literalText(node.value), literal: true };
		case "DoubleQuoted":
			return wordPartsToLiteralText(node.parts);
		case "CommandSubstitution":
			return {
				text: "",
				literal: false,
				reason: "command substitution",
			};
		case "ProcessSubstitution":
			return {
				text: "",
				literal: false,
				reason: "process substitution",
			};
		case "ParameterExpansion":
			return {
				text: "",
				literal: false,
				reason: "parameter expansion",
			};
		case "ArithmeticExpansion":
			return {
				text: "",
				literal: false,
				reason: "arithmetic expansion",
			};
		case "Glob":
			return { text: "", literal: false, reason: "glob expansion" };
		case "BraceExpansion":
			return { text: "", literal: false, reason: "brace expansion" };
		case "TildeExpansion":
			return { text: "", literal: false, reason: "tilde expansion" };
		default:
			return {
				text: "",
				literal: false,
				reason: `${literalText(node.type) || "unknown"} word part`,
			};
	}
}

function wordPartsToLiteralText(parts: unknown): WordToken {
	if (!Array.isArray(parts)) {
		return { text: "", literal: false, reason: "missing word parts" };
	}

	let text = "";
	for (const part of parts) {
		const converted = literalPartToText(part);
		if (!converted.literal) {
			return converted;
		}
		text += converted.text;
	}

	return { text, literal: true };
}

function wordToLiteralToken(word: unknown): WordToken {
	const node = asNode(word);
	if (!node) {
		return { text: "", literal: false, reason: "missing word" };
	}

	return wordPartsToLiteralText(node.parts);
}

function assignmentToToken(assignment: unknown): WordToken {
	const node = asNode(assignment);
	const name = literalText(node?.name);
	const valueWord = node?.value ?? node?.word;
	const value = valueWord
		? wordToLiteralToken(valueWord)
		: { text: "", literal: true };

	if (!name) {
		return {
			text: "",
			literal: false,
			reason: "assignment without name",
		};
	}

	if (!value.literal) {
		return {
			text: `${name}=`,
			literal: false,
			reason: value.reason ?? "dynamic assignment",
		};
	}

	return { text: `${name}=${value.text}`, literal: true };
}

function wordsToTokens(words: unknown): WordToken[] {
	if (!Array.isArray(words)) {
		return [];
	}

	return words.map((word) => wordToLiteralToken(word));
}

function assignmentsToTokens(assignments: unknown): WordToken[] {
	if (!Array.isArray(assignments)) {
		return [];
	}

	return assignments.map((assignment) => assignmentToToken(assignment));
}

function redirectionsToTokens(
	redirections: unknown,
): RedirectionToken[] {
	if (!Array.isArray(redirections)) {
		return [];
	}

	return redirections.map((redirection) => {
		const node = asNode(redirection);
		const target = asNode(node?.target);
		return {
			operator: literalText(node?.operator),
			targetKind: literalText(target?.type),
		};
	});
}

function isAssignmentToken(token: WordToken): boolean {
	return token.literal && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token.text);
}

function unwrapSimpleWrapper(
	args: WordToken[],
): UnwrappedCommand | null {
	let index = 0;

	while (index < args.length) {
		const token = args[index];
		if (!token) {
			break;
		}
		if (!token.literal) {
			return {
				command: token,
				args: args.slice(index + 1),
				assignments: [],
			};
		}
		if (token.text === "--") {
			index += 1;
			break;
		}
		if (token.text.startsWith("-")) {
			index += 1;
			continue;
		}
		break;
	}

	const command = args[index];
	if (!command) {
		return null;
	}

	return {
		command,
		args: args.slice(index + 1),
		assignments: [],
	};
}

function unwrapEnv(args: WordToken[]): UnwrappedCommand | null {
	let index = 0;
	const assignments: string[] = [];

	while (index < args.length) {
		const token = args[index];
		if (!token) {
			break;
		}
		if (!token.literal) {
			return {
				command: token,
				args: args.slice(index + 1),
				assignments,
			};
		}
		if (token.text === "--") {
			index += 1;
			break;
		}
		if (isAssignmentToken(token)) {
			assignments.push(token.text);
			index += 1;
			continue;
		}
		if (
			token.text === "-i" ||
			token.text === "-0" ||
			token.text === "--ignore-environment"
		) {
			index += 1;
			continue;
		}
		if (
			token.text === "-u" ||
			token.text === "--unset" ||
			token.text === "-C" ||
			token.text === "--chdir"
		) {
			index += 2;
			continue;
		}
		if (
			token.text.startsWith("--unset=") ||
			token.text.startsWith("--chdir=")
		) {
			index += 1;
			continue;
		}
		if (token.text.startsWith("-")) {
			index += 1;
			continue;
		}
		break;
	}

	const command = args[index];
	if (!command) {
		return null;
	}

	return {
		command,
		args: args.slice(index + 1),
		assignments,
	};
}

function unwrapExec(args: WordToken[]): UnwrappedCommand | null {
	let index = 0;

	while (index < args.length) {
		const token = args[index];
		if (!token) {
			break;
		}
		if (!token.literal) {
			return {
				command: token,
				args: args.slice(index + 1),
				assignments: [],
			};
		}
		if (token.text === "--") {
			index += 1;
			break;
		}
		if (token.text === "-a") {
			index += 2;
			continue;
		}
		if (token.text.startsWith("-a") && token.text.length > 2) {
			index += 1;
			continue;
		}
		if (token.text.startsWith("-")) {
			index += 1;
			continue;
		}
		break;
	}

	const command = args[index];
	if (!command) {
		return null;
	}

	return {
		command,
		args: args.slice(index + 1),
		assignments: [],
	};
}

function unwrapLayer(
	command: WordToken,
	args: WordToken[],
): UnwrappedCommand | null {
	if (!command.literal) {
		return null;
	}

	switch (commandBaseName(command.text)) {
		case "command":
		case "nohup":
			return unwrapSimpleWrapper(args);
		case "env":
			return unwrapEnv(args);
		case "exec":
			return unwrapExec(args);
		default:
			return null;
	}
}

function resolveEffectiveCommand(
	command: WordToken,
	args: WordToken[],
	assignments: string[],
): UnwrappedCommand {
	let current: UnwrappedCommand = {
		command,
		args,
		assignments: [...assignments],
	};
	const seen = new Set<string>();

	while (current.command.literal) {
		const key = `${current.command.text}\0${current.args.map((arg) => arg.text).join("\0")}`;
		if (seen.has(key)) {
			break;
		}
		seen.add(key);

		const unwrapped = unwrapLayer(current.command, current.args);
		if (!unwrapped) {
			break;
		}

		current = {
			command: unwrapped.command,
			args: unwrapped.args,
			assignments: [...current.assignments, ...unwrapped.assignments],
		};
	}

	return current;
}

function collectNestedScriptsFromWord(
	word: unknown,
	visitScript: VisitScript,
): void {
	const node = asNode(word);
	if (!node || !Array.isArray(node.parts)) {
		return;
	}

	for (const part of node.parts) {
		const partNode = asNode(part);
		if (!partNode) {
			continue;
		}

		if (partNode.type === "DoubleQuoted") {
			collectNestedScriptsFromWord(partNode, visitScript);
			continue;
		}

		if (
			(partNode.type === "CommandSubstitution" ||
				partNode.type === "ProcessSubstitution") &&
			partNode.body
		) {
			visitScript(partNode.body);
		}
	}
}

function collectNestedScriptsFromSimpleCommand(
	commandNode: unknown,
	visitScript: VisitScript,
): void {
	const node = asNode(commandNode);
	if (!node) {
		return;
	}

	if (node.name) {
		collectNestedScriptsFromWord(node.name, visitScript);
	}

	for (const arg of nodeArray(node, "args")) {
		collectNestedScriptsFromWord(arg, visitScript);
	}

	for (const assignment of nodeArray(node, "assignments")) {
		const assignmentNode = asNode(assignment);
		if (assignmentNode?.value) {
			collectNestedScriptsFromWord(assignmentNode.value, visitScript);
		}
		if (assignmentNode?.word) {
			collectNestedScriptsFromWord(assignmentNode.word, visitScript);
		}
	}

	for (const redirection of nodeArray(node, "redirections")) {
		const redirectionNode = asNode(redirection);
		if (redirectionNode?.target) {
			collectNestedScriptsFromWord(redirectionNode.target, visitScript);
		}
	}
}

function hasAliasSetup(
	commandName: string,
	args: WordToken[],
): boolean {
	if (commandBaseName(commandName) !== "alias") {
		return false;
	}

	return args.some((arg) => !arg.literal || arg.text.includes("="));
}

function hasOpaqueStdinRedirection(
	redirections: RedirectionToken[],
): boolean {
	return redirections.some(
		(redirection) =>
			redirection.targetKind === "HereDoc" ||
			redirection.operator === "<<<" ||
			redirection.operator === "<" ||
			redirection.operator === "<&",
	);
}

function hasOpaqueInputArg(argv: string[]): boolean {
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index] ?? "";
		if (token === "--input" && argv[index + 1] === "-") {
			return true;
		}
		if (token === "--input=-") {
			return true;
		}
	}

	return false;
}

function hasNonReviewablePromptArg(argv: string[]): string | null {
	if (argv.includes("--editor")) {
		return "--editor";
	}
	if (argv.includes("--web")) {
		return "--web";
	}
	return null;
}

function validateGhInvocation(
	command: UnwrappedCommand,
	pipelineIndex: number,
	redirections: RedirectionToken[],
): ExtractionResult | null {
	if (!command.command.literal) {
		return ambiguous("dynamic command word may hide gh");
	}

	for (const assignment of command.assignments) {
		if (!assignment) {
			return ambiguous("dynamic assignment before gh");
		}
	}

	for (const [index, arg] of command.args.entries()) {
		if (arg.literal) {
			continue;
		}
		if (index === 0) {
			return ambiguous("dynamic subcommand in gh invocation");
		}
		return ambiguous(
			`non-literal gh argument uses ${arg.reason ?? "dynamic expansion"}`,
		);
	}

	const argv = [
		command.command.text,
		...command.args.map((arg) => arg.text),
	];
	const promptArg = hasNonReviewablePromptArg(argv);
	if (promptArg) {
		return ambiguous(`gh invocation uses non-reviewable ${promptArg}`);
	}

	if (hasOpaqueInputArg(argv)) {
		return ambiguous("gh api uses opaque stdin via --input -");
	}

	if (hasOpaqueStdinRedirection(redirections)) {
		return ambiguous(
			"gh invocation uses heredoc or opaque stdin redirection",
		);
	}

	if (pipelineIndex > 0) {
		return ambiguous(
			"gh invocation reads opaque stdin from a pipeline",
		);
	}

	return null;
}

function visitSimpleCommand(
	commandNode: unknown,
	pipelineIndex: number,
	state: TraversalState,
	visitScript: VisitScript,
): void {
	const node = asNode(commandNode);
	if (!node) {
		return;
	}

	collectNestedScriptsFromSimpleCommand(node, visitScript);
	if (state.ambiguous) {
		return;
	}

	if (!node.name) {
		return;
	}

	const commandName = wordToLiteralToken(node.name);
	if (!commandName.literal) {
		state.ambiguous = ambiguous("dynamic command word may hide gh");
		return;
	}

	const args = wordsToTokens(node.args);
	if (hasAliasSetup(commandName.text, args)) {
		state.ambiguous = ambiguous("alias setup is not reviewable");
		return;
	}

	const assignmentTokens = assignmentsToTokens(node.assignments);
	const assignments: string[] = [];
	for (const assignment of assignmentTokens) {
		if (!assignment.literal) {
			assignments.push(assignment.text);
			continue;
		}
		assignments.push(assignment.text);
	}

	const effective = resolveEffectiveCommand(
		commandName,
		args,
		assignments,
	);
	if (!effective.command.literal) {
		state.ambiguous = ambiguous("dynamic command word may hide gh");
		return;
	}

	if (commandBaseName(effective.command.text) !== "gh") {
		return;
	}

	for (const assignment of assignmentTokens) {
		if (!assignment.literal) {
			state.ambiguous = ambiguous(
				`non-literal assignment before gh uses ${assignment.reason ?? "dynamic expansion"}`,
			);
			return;
		}
	}

	const redirections = redirectionsToTokens(node.redirections);
	const validationFailure = validateGhInvocation(
		effective,
		pipelineIndex,
		redirections,
	);
	if (validationFailure) {
		state.ambiguous = validationFailure;
		return;
	}

	state.invocations.push({
		assignments: effective.assignments,
		argv: [
			effective.command.text,
			...effective.args.map((arg) => arg.text),
		],
	});
}

function visitCommandNode(
	commandNode: unknown,
	pipelineIndex: number,
	state: TraversalState,
	visitScript: VisitScript,
): void {
	const node = asNode(commandNode);
	if (!node || state.ambiguous) {
		return;
	}

	if (node.type === "SimpleCommand") {
		visitSimpleCommand(node, pipelineIndex, state, visitScript);
		return;
	}

	if (node.type === "FunctionDef") {
		state.ambiguous = ambiguous(
			"shell function definitions are not reviewable",
		);
		return;
	}

	const body = asNode(node.body);
	if (body && Array.isArray(body.statements)) {
		visitScript(body);
	}
	if (Array.isArray(node.body)) {
		visitScript({ statements: node.body });
	}
	if (Array.isArray(node.condition)) {
		visitScript({ statements: node.condition });
	}
	if (Array.isArray(node.elseBody)) {
		visitScript({ statements: node.elseBody });
	}
	for (const clause of nodeArray(node, "clauses")) {
		const clauseNode = asNode(clause);
		if (Array.isArray(clauseNode?.condition)) {
			visitScript({ statements: clauseNode.condition });
		}
		if (Array.isArray(clauseNode?.body)) {
			visitScript({ statements: clauseNode.body });
		}
	}
	for (const item of nodeArray(node, "items")) {
		const itemNode = asNode(item);
		if (Array.isArray(itemNode?.body)) {
			visitScript({ statements: itemNode.body });
		}
	}
}

function analyzeAst(ast: unknown): ExtractionResult {
	const state: TraversalState = { invocations: [] };

	const visitScript = (script: unknown): void => {
		if (state.ambiguous) {
			return;
		}
		const scriptNode = asNode(script);
		if (!scriptNode || !Array.isArray(scriptNode.statements)) {
			return;
		}

		for (const statement of scriptNode.statements) {
			if (state.ambiguous) {
				return;
			}
			const statementNode = asNode(statement);
			if (!statementNode || !Array.isArray(statementNode.pipelines)) {
				continue;
			}

			for (const pipeline of statementNode.pipelines) {
				if (state.ambiguous) {
					return;
				}
				const pipelineNode = asNode(pipeline);
				if (!pipelineNode || !Array.isArray(pipelineNode.commands)) {
					continue;
				}

				for (const [
					pipelineIndex,
					commandNode,
				] of pipelineNode.commands.entries()) {
					visitCommandNode(
						commandNode,
						pipelineIndex,
						state,
						visitScript,
					);
					if (state.ambiguous) {
						return;
					}
				}
			}
		}
	};

	visitScript(ast);

	return (
		state.ambiguous ?? {
			kind: "reviewable",
			invocations: state.invocations,
		}
	);
}

export function extractGhInvocations(
	command: string,
): ExtractionResult {
	const parser = loadParseBash();
	if (!parser) {
		return riskyWhenParserUnavailable(command)
			? ambiguous(
					"bash parser unavailable while command may mention or hide gh",
				)
			: { kind: "reviewable", invocations: [] };
	}

	let ast: unknown;
	try {
		ast = parser(command);
	} catch (error) {
		if (riskyWhenParserUnavailable(command)) {
			const message =
				error instanceof Error ? error.message : String(error);
			return ambiguous(
				`bash parse failed while command may mention or hide gh: ${message}`,
			);
		}
		return { kind: "reviewable", invocations: [] };
	}

	return analyzeAst(ast);
}
