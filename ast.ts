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

type TraversalContext = {
	inheritedRedirections: RedirectionToken[];
	inheritedPipelineStdin: boolean;
};

type BashNode = Record<string, unknown>;
type VisitScript = (
	script: unknown,
	context?: TraversalContext,
) => void;

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

export function setParseBashForTest(
	parser: ParseBash | null | undefined,
): void {
	parseBash = parser;
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

function containsGhCommandWord(text: string): boolean {
	return /(^|[^A-Za-z0-9_-])gh([^A-Za-z0-9_-]|$)/.test(text);
}

function containsShellLiteralGhCommandWord(command: string): boolean {
	let word = "";
	let inSingleQuotes = false;
	let inDoubleQuotes = false;
	let escaped = false;

	const flushWord = (): boolean => {
		const containsGh = containsGhCommandWord(word);
		word = "";
		return containsGh;
	};

	for (const char of command) {
		if (escaped) {
			word += char;
			escaped = false;
			continue;
		}

		if (char === "\\" && !inSingleQuotes) {
			escaped = true;
			continue;
		}

		if (char === "'" && !inDoubleQuotes) {
			inSingleQuotes = !inSingleQuotes;
			continue;
		}

		if (char === '"' && !inSingleQuotes) {
			inDoubleQuotes = !inDoubleQuotes;
			continue;
		}

		if (
			!inSingleQuotes &&
			!inDoubleQuotes &&
			/[\s;&|()<>]/.test(char)
		) {
			if (flushWord()) {
				return true;
			}
			continue;
		}

		word += char;
	}

	if (escaped) {
		word += "\\";
	}

	return flushWord();
}

function normalizeLineContinuations(command: string): string {
	return command.replace(/\\\r?\n/g, "");
}

function fallbackShellWords(command: string): string[] {
	const words: string[] = [];
	let word = "";
	let inSingleQuotes = false;
	let inDoubleQuotes = false;
	let escaped = false;

	const flushWord = (): void => {
		if (word) {
			words.push(word);
			word = "";
		}
	};

	for (const char of command) {
		if (escaped) {
			word += char;
			escaped = false;
			continue;
		}

		if (char === "\\" && !inSingleQuotes) {
			escaped = true;
			continue;
		}

		if (char === "'" && !inDoubleQuotes) {
			inSingleQuotes = !inSingleQuotes;
			continue;
		}

		if (char === '"' && !inSingleQuotes) {
			inDoubleQuotes = !inDoubleQuotes;
			continue;
		}

		if (
			!inSingleQuotes &&
			!inDoubleQuotes &&
			/[\s;&|()<>]/.test(char)
		) {
			flushWord();
			continue;
		}

		word += char;
	}

	if (escaped) {
		word += "\\";
	}
	flushWord();

	return words;
}

function expandSimpleBraces(pattern: string, limit = 32): string[] {
	const start = pattern.indexOf("{");
	if (start < 0) {
		return [pattern];
	}

	const end = pattern.indexOf("}", start + 1);
	if (end < 0) {
		return [pattern];
	}

	const variants = pattern.slice(start + 1, end).split(",");
	const prefix = pattern.slice(0, start);
	const suffix = pattern.slice(end + 1);
	const expanded: string[] = [];

	for (const variant of variants) {
		for (const tail of expandSimpleBraces(suffix, limit)) {
			expanded.push(`${prefix}${variant}${tail}`);
			if (expanded.length >= limit) {
				return expanded;
			}
		}
	}

	return expanded;
}

function globPatternCanMatchGh(pattern: string): boolean {
	const candidates = expandSimpleBraces(pattern);

	return candidates.some((candidate) => {
		let regex = "^";
		for (let index = 0; index < candidate.length; index += 1) {
			const char = candidate[index] ?? "";
			if (char === "*") {
				regex += ".*";
				continue;
			}
			if (char === "?") {
				regex += ".";
				continue;
			}
			if (char === "[") {
				const end = candidate.indexOf("]", index + 1);
				if (end < 0) {
					regex += "\\[";
					continue;
				}
				const content = candidate.slice(index + 1, end);
				const normalizedContent = content.startsWith("!")
					? `^${content.slice(1)}`
					: content;
				regex += `[${normalizedContent}]`;
				index = end;
				continue;
			}
			regex += char.replace(/[\\^$+?.()|{}]/g, "\\$&");
		}
		regex += "$";

		try {
			return new RegExp(regex).test("gh");
		} catch {
			return false;
		}
	});
}

function containsDynamicGhLikeCommandWord(command: string): boolean {
	return fallbackShellWords(command).some((word) => {
		const baseName = commandBaseName(word);
		return (
			/[{}[\]*?]/.test(baseName) && globPatternCanMatchGh(baseName)
		);
	});
}

function shellSyntaxOnly(command: string): string {
	let view = "";
	let inSingleQuotes = false;
	let inDoubleQuotes = false;
	let escaped = false;

	for (const char of command) {
		if (escaped) {
			view += inSingleQuotes ? quotedSyntaxPlaceholder(char) : " ";
			escaped = false;
			continue;
		}

		if (char === "\\" && !inSingleQuotes) {
			view += " ";
			escaped = true;
			continue;
		}

		if (char === "'" && !inDoubleQuotes) {
			inSingleQuotes = !inSingleQuotes;
			view += " ";
			continue;
		}

		if (char === '"' && !inSingleQuotes) {
			inDoubleQuotes = !inDoubleQuotes;
			view += " ";
			continue;
		}

		view +=
			inSingleQuotes || inDoubleQuotes
				? quotedSyntaxPlaceholder(char)
				: char;
	}

	return view;
}

function quotedSyntaxPlaceholder(char: string): string {
	return /\s/.test(char) ? " " : "q";
}

const fallbackControlTokens = new Set([
	";",
	"&&",
	"||",
	"\n",
	"&",
	"(",
	")",
	"{",
	"}",
]);

const stdinRedirectionTokens = new Set(["<", "<<", "<<<", "<&"]);

function isShellSyntaxOperatorStart(char: string): boolean {
	return ";&|(){}<>".includes(char);
}

function fallbackSyntaxTokens(command: string): string[] {
	const view = shellSyntaxOnly(command);
	const tokens: string[] = [];
	let index = 0;

	while (index < view.length) {
		const char = view[index] ?? "";

		if (char === "\n") {
			tokens.push("\n");
			index += 1;
			continue;
		}

		if (/\s/.test(char)) {
			index += 1;
			continue;
		}

		const pair = view.slice(index, index + 2);
		const triple = view.slice(index, index + 3);
		if (triple === "<<<") {
			tokens.push(triple);
			index += 3;
			continue;
		}
		if (["&&", "||", "|&", "<<", "<&", ">>"].includes(pair)) {
			tokens.push(pair);
			index += 2;
			continue;
		}
		if (isShellSyntaxOperatorStart(char)) {
			tokens.push(char);
			index += 1;
			continue;
		}

		if (/\d/.test(char)) {
			const digitStart = index;
			while (/\d/.test(view[index] ?? "")) {
				index += 1;
			}
			if ((view[index] ?? "") === "<" || (view[index] ?? "") === ">") {
				const redirectStart = index;
				const redirectPair = view.slice(index, index + 2);
				const redirectTriple = view.slice(index, index + 3);
				if (redirectTriple === "<<<") {
					tokens.push(redirectTriple);
					index += 3;
					continue;
				}
				if (["<<", "<&", ">>"].includes(redirectPair)) {
					tokens.push(redirectPair);
					index += 2;
					continue;
				}
				tokens.push(view[redirectStart] ?? "");
				index += 1;
				continue;
			}
			index = digitStart;
		}

		let word = "";
		while (index < view.length) {
			const wordChar = view[index] ?? "";
			if (/\s/.test(wordChar) || isShellSyntaxOperatorStart(wordChar)) {
				break;
			}
			word += wordChar;
			index += 1;
		}
		if (word) {
			tokens.push(word);
		}
	}

	return tokens;
}

function removeFallbackRedirections(tokens: string[]): string[] {
	const words: string[] = [];
	let skipNext = false;

	for (const token of tokens) {
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (stdinRedirectionTokens.has(token) || token === ">") {
			skipNext = true;
			continue;
		}
		if (
			!fallbackControlTokens.has(token) &&
			token !== "|" &&
			token !== "|&"
		) {
			words.push(token);
		}
	}

	return words;
}

function skipFallbackEnvOptions(
	words: string[],
	index: number,
): number {
	let current = index;

	while (current < words.length) {
		const word = words[current] ?? "";
		if (word === "--") {
			return current + 1;
		}
		if (isAssignmentToken({ text: word, literal: true })) {
			current += 1;
			continue;
		}
		if (
			word === "-u" ||
			word === "--unset" ||
			word === "-C" ||
			word === "--chdir" ||
			word === "-S" ||
			word === "--split-string"
		) {
			current += 2;
			continue;
		}
		if (
			word.startsWith("--unset=") ||
			word.startsWith("--chdir=") ||
			word.startsWith("--split-string=")
		) {
			current += 1;
			continue;
		}
		if (word.startsWith("-")) {
			current += 1;
			continue;
		}
		break;
	}

	return current;
}

function skipFallbackWrapperOptions(
	baseName: string,
	words: string[],
	index: number,
): number {
	let current = index;

	while (current < words.length) {
		const word = words[current] ?? "";
		if (word === "--") {
			return current + 1;
		}
		if (baseName === "exec" && word === "-a") {
			current += 2;
			continue;
		}
		if (word.startsWith("-")) {
			current += 1;
			continue;
		}
		break;
	}

	return current;
}

function fallbackEffectiveCommandWord(tokens: string[]): string | null {
	const words = removeFallbackRedirections(tokens);
	let index = 0;
	const seen = new Set<number>();

	while (index < words.length && !seen.has(index)) {
		seen.add(index);

		const word = words[index] ?? "";
		if (isAssignmentToken({ text: word, literal: true })) {
			index += 1;
			continue;
		}

		const baseName = commandBaseName(word);
		if (baseName === "env") {
			index = skipFallbackEnvOptions(words, index + 1);
			continue;
		}
		if (
			baseName === "command" ||
			baseName === "nohup" ||
			baseName === "exec" ||
			baseName === "builtin"
		) {
			index = skipFallbackWrapperOptions(baseName, words, index + 1);
			continue;
		}

		return word || null;
	}

	return null;
}

function fallbackSegmentHasStdinRedirection(tokens: string[]): boolean {
	return tokens.some((token) => stdinRedirectionTokens.has(token));
}

function fallbackSegmentHasEnvSplitString(tokens: string[]): boolean {
	const words = removeFallbackRedirections(tokens);

	for (let index = 0; index < words.length; index += 1) {
		const baseName = commandBaseName(words[index] ?? "");
		if (baseName !== "env") {
			continue;
		}

		for (const word of words.slice(index + 1)) {
			if (word === "--") {
				break;
			}
			if (
				word === "-S" ||
				word === "--split-string" ||
				word.startsWith("--split-string=")
			) {
				return true;
			}
			if (
				!word.startsWith("-") &&
				!isAssignmentToken({ text: word, literal: true })
			) {
				break;
			}
		}
	}

	return false;
}

function fallbackSegmentHasOpaqueShellStdin(
	tokens: string[],
	inheritedPipelineStdin: boolean,
): boolean {
	if (fallbackSegmentHasEnvSplitString(tokens)) {
		return true;
	}

	const command = fallbackEffectiveCommandWord(tokens);
	const baseName = command ? commandBaseName(command) : "";

	return (
		(baseName === "bash" || baseName === "sh" || baseName === "zsh") &&
		(inheritedPipelineStdin ||
			fallbackSegmentHasStdinRedirection(tokens))
	);
}

function shellExecutableReadsOpaqueStdin(command: string): boolean {
	let segment: string[] = [];
	let inheritedPipelineStdin = false;
	let pipelineStdinDepth = 0;

	const flushSegment = (): boolean => {
		const isOpaqueShellStdin = fallbackSegmentHasOpaqueShellStdin(
			segment,
			inheritedPipelineStdin,
		);
		segment = [];
		return isOpaqueShellStdin;
	};

	for (const token of fallbackSyntaxTokens(command)) {
		if (token === "|" || token === "|&") {
			if (flushSegment()) {
				return true;
			}
			inheritedPipelineStdin = true;
			continue;
		}

		if (token === "(" || token === "{") {
			if (inheritedPipelineStdin) {
				pipelineStdinDepth += 1;
			}
			continue;
		}

		if (token === ")" || token === "}") {
			if (flushSegment()) {
				return true;
			}
			if (pipelineStdinDepth > 0) {
				pipelineStdinDepth -= 1;
			}
			if (pipelineStdinDepth === 0) {
				inheritedPipelineStdin = false;
			}
			continue;
		}

		if (fallbackControlTokens.has(token)) {
			if (flushSegment()) {
				return true;
			}
			if (pipelineStdinDepth === 0) {
				inheritedPipelineStdin = false;
			}
			continue;
		}

		segment.push(token);
	}

	return flushSegment();
}

function riskyWhenParserUnavailable(command: string): boolean {
	const lineContinuedCommand = normalizeLineContinuations(command);
	return (
		containsShellLiteralGhCommandWord(lineContinuedCommand) ||
		containsDynamicGhLikeCommandWord(lineContinuedCommand) ||
		shellExecutableReadsOpaqueStdin(lineContinuedCommand) ||
		/[$`]|\b(alias|function|eval|source)\b/.test(command) ||
		/(^|[;&|()\s])\.(?=([;&|()\s]|$))/.test(command)
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
			token.text === "-S" ||
			token.text === "--split-string" ||
			token.text.startsWith("--split-string=")
		) {
			return {
				command: {
					text: "",
					literal: false,
					reason: "env split-string is not reviewable",
				},
				args: args.slice(index + 1),
				assignments,
			};
		}
		if (token.text === "-0") {
			index += 1;
			continue;
		}
		if (token.text === "-i" || token.text === "--ignore-environment") {
			return {
				command: {
					text: token.text,
					literal: false,
					reason: `env state-mutating option ${token.text} is not reviewable`,
				},
				args: args.slice(index + 1),
				assignments,
			};
		}
		if (
			token.text === "-u" ||
			token.text === "--unset" ||
			token.text === "-C" ||
			token.text === "--chdir"
		) {
			return {
				command: {
					text: token.text,
					literal: false,
					reason: `env state-mutating option ${token.text} is not reviewable`,
				},
				args: args.slice(index + 1),
				assignments,
			};
		}
		if (
			token.text.startsWith("--unset=") ||
			token.text.startsWith("--chdir=")
		) {
			return {
				command: {
					text: token.text,
					literal: false,
					reason: `env state-mutating option ${token.text} is not reviewable`,
				},
				args: args.slice(index + 1),
				assignments,
			};
		}
		if (token.text.startsWith("-")) {
			return {
				command: {
					text: token.text,
					literal: false,
					reason: `unsupported env option ${token.text} is not reviewable`,
				},
				args: args.slice(index + 1),
				assignments,
			};
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

function commandWrapperIsQueryMode(args: WordToken[]): boolean {
	for (const arg of args) {
		if (!arg.literal) {
			return false;
		}
		if (arg.text === "--") {
			return false;
		}
		if (!arg.text.startsWith("-") || arg.text === "-") {
			return false;
		}
		if (!arg.text.startsWith("--") && /[vV]/.test(arg.text.slice(1))) {
			return true;
		}
	}

	return false;
}

function unwrapLayer(
	command: WordToken,
	args: WordToken[],
): UnwrappedCommand | null {
	if (!command.literal) {
		return null;
	}

	switch (commandBaseName(command.text)) {
		case "builtin":
		case "nohup":
			return unwrapSimpleWrapper(args);
		case "command":
			return commandWrapperIsQueryMode(args)
				? null
				: unwrapSimpleWrapper(args);
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

function containsNestedExecution(value: unknown): boolean {
	const node = asNode(value);
	if (!node) {
		if (Array.isArray(value)) {
			return value.some((item) => containsNestedExecution(item));
		}
		return false;
	}

	if (
		node.type === "CommandSubstitution" ||
		node.type === "ProcessSubstitution" ||
		node.type === "ArithCommandSubst"
	) {
		return true;
	}

	return Object.values(node).some((item) =>
		containsNestedExecution(item),
	);
}

function expansionNestedExecutionReason(
	partNode: BashNode,
): string | null {
	if (
		partNode.type === "ParameterExpansion" &&
		containsNestedExecution(partNode)
	) {
		return "parameter expansion contains nested command or process substitution that may execute gh";
	}

	if (
		partNode.type === "ArithmeticExpansion" &&
		containsNestedExecution(partNode)
	) {
		return "arithmetic expansion contains nested command or process substitution that may execute gh";
	}

	return null;
}

function collectNestedScriptsFromWord(
	word: unknown,
	visitScript: VisitScript,
	context?: TraversalContext,
): string | null {
	const node = asNode(word);
	if (!node || !Array.isArray(node.parts)) {
		return null;
	}

	for (const part of node.parts) {
		const partNode = asNode(part);
		if (!partNode) {
			continue;
		}

		if (partNode.type === "DoubleQuoted") {
			const reason = collectNestedScriptsFromWord(
				partNode,
				visitScript,
				context,
			);
			if (reason) {
				return reason;
			}
			continue;
		}

		const expansionReason = expansionNestedExecutionReason(partNode);
		if (expansionReason) {
			return expansionReason;
		}

		if (
			(partNode.type === "CommandSubstitution" ||
				partNode.type === "ProcessSubstitution") &&
			partNode.body
		) {
			visitScript(partNode.body, context);
		}
	}

	return null;
}

function collectNestedScriptsFromSimpleCommand(
	commandNode: unknown,
	visitScript: VisitScript,
	context?: TraversalContext,
): string | null {
	const node = asNode(commandNode);
	if (!node) {
		return null;
	}

	if (node.name) {
		const reason = collectNestedScriptsFromWord(
			node.name,
			visitScript,
			context,
		);
		if (reason) {
			return reason;
		}
	}

	for (const arg of nodeArray(node, "args")) {
		const reason = collectNestedScriptsFromWord(
			arg,
			visitScript,
			context,
		);
		if (reason) {
			return reason;
		}
	}

	for (const assignment of nodeArray(node, "assignments")) {
		const assignmentNode = asNode(assignment);
		if (assignmentNode?.value) {
			const reason = collectNestedScriptsFromWord(
				assignmentNode.value,
				visitScript,
				context,
			);
			if (reason) {
				return reason;
			}
		}
		if (assignmentNode?.word) {
			const reason = collectNestedScriptsFromWord(
				assignmentNode.word,
				visitScript,
				context,
			);
			if (reason) {
				return reason;
			}
		}
	}

	for (const redirection of nodeArray(node, "redirections")) {
		const redirectionNode = asNode(redirection);
		if (redirectionNode?.target) {
			const reason = collectNestedScriptsFromWord(
				redirectionNode.target,
				visitScript,
				context,
			);
			if (reason) {
				return reason;
			}
		}
	}

	return null;
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

function shellArgUsesCommandStringOption(arg: WordToken): boolean {
	if (!arg.literal) {
		return true;
	}

	return (
		arg.text === "-c" ||
		(arg.text.startsWith("-") &&
			!arg.text.startsWith("--") &&
			arg.text.slice(1).includes("c"))
	);
}

function remainingShellArgsMayUseCommandString(
	args: WordToken[],
	startIndex: number,
): boolean {
	for (let index = startIndex; index < args.length; index += 1) {
		const arg = args[index];
		if (!arg) {
			continue;
		}
		if (!arg.literal) {
			return true;
		}
		if (arg.text === "--") {
			return false;
		}
		if (shellArgUsesCommandStringOption(arg)) {
			return true;
		}
	}

	return false;
}

function shellArgsUseCommandString(args: WordToken[]): boolean {
	let skipOptionValue = false;

	for (const [index, arg] of args.entries()) {
		if (!arg.literal) {
			return true;
		}

		if (skipOptionValue) {
			skipOptionValue = false;
			continue;
		}

		if (arg.text === "--") {
			return false;
		}

		if (arg.text === "-c") {
			return true;
		}

		if (
			arg.text === "-O" ||
			arg.text === "+O" ||
			arg.text === "-o" ||
			arg.text === "+o" ||
			arg.text === "--rcfile" ||
			arg.text === "--init-file" ||
			arg.text === "--emulate"
		) {
			skipOptionValue = true;
			continue;
		}

		if (arg.text.startsWith("-O") || arg.text.startsWith("+O")) {
			continue;
		}

		if (
			arg.text.startsWith("--rcfile=") ||
			arg.text.startsWith("--init-file=") ||
			arg.text.startsWith("--emulate=")
		) {
			continue;
		}

		if (arg.text.startsWith("-") && !arg.text.startsWith("--")) {
			if (arg.text.slice(1).includes("c")) {
				return true;
			}
			continue;
		}

		if (arg.text.startsWith("--")) {
			return remainingShellArgsMayUseCommandString(args, index + 1);
		}

		return false;
	}

	return false;
}

function commandExecutingShellFormReason(
	command: UnwrappedCommand,
	stdinReason: string | null,
): string | null {
	const baseName = commandBaseName(command.command.text);

	if (baseName === "eval") {
		return "eval shell strings are not reviewable";
	}

	if (baseName === "source" || baseName === ".") {
		return "source shell file loading is not reviewable";
	}

	if (
		(baseName === "bash" || baseName === "sh" || baseName === "zsh") &&
		shellArgsUseCommandString(command.args)
	) {
		return "shell executable -c scripts are not reviewable";
	}

	if (
		(baseName === "bash" || baseName === "sh" || baseName === "zsh") &&
		stdinReason
	) {
		return `shell executable reads opaque script from ${stdinReason}`;
	}

	return null;
}

function opaqueStdinReason(
	redirections: RedirectionToken[],
	pipelineIndex: number,
	inheritedPipelineStdin: boolean,
): string | null {
	if (
		redirections.some(
			(redirection) => redirection.targetKind === "HereDoc",
		)
	) {
		return "heredoc stdin";
	}

	if (
		redirections.some(
			(redirection) =>
				redirection.operator === "<<<" ||
				redirection.operator === "<" ||
				redirection.operator === "<&",
		)
	) {
		return "stdin redirection";
	}

	if (pipelineIndex > 0 || inheritedPipelineStdin) {
		return "pipeline stdin";
	}

	return null;
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
	inheritedPipelineStdin: boolean,
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

	const stdinReason = opaqueStdinReason(
		redirections,
		pipelineIndex,
		inheritedPipelineStdin,
	);
	if (stdinReason) {
		return ambiguous(
			`gh invocation reads opaque stdin from ${stdinReason}`,
		);
	}

	return null;
}

function visitSimpleCommand(
	commandNode: unknown,
	pipelineIndex: number,
	context: TraversalContext,
	state: TraversalState,
	visitScript: VisitScript,
): void {
	const node = asNode(commandNode);
	if (!node) {
		return;
	}

	const nestedReason = collectNestedScriptsFromSimpleCommand(
		node,
		visitScript,
		context,
	);
	if (nestedReason) {
		state.ambiguous = ambiguous(nestedReason);
		return;
	}
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
		state.ambiguous = ambiguous(
			effective.command.reason ?? "dynamic command word may hide gh",
		);
		return;
	}

	if (hasAliasSetup(effective.command.text, effective.args)) {
		state.ambiguous = ambiguous("alias setup is not reviewable");
		return;
	}

	const redirections = [
		...context.inheritedRedirections,
		...redirectionsToTokens(node.redirections),
	];
	const shellFormReason = commandExecutingShellFormReason(
		effective,
		opaqueStdinReason(
			redirections,
			pipelineIndex,
			context.inheritedPipelineStdin,
		),
	);
	if (shellFormReason) {
		state.ambiguous = ambiguous(shellFormReason);
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

	const validationFailure = validateGhInvocation(
		effective,
		pipelineIndex,
		redirections,
		context.inheritedPipelineStdin,
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
	context: TraversalContext,
	state: TraversalState,
	visitScript: VisitScript,
): void {
	const node = asNode(commandNode);
	if (!node || state.ambiguous) {
		return;
	}

	if (node.type === "SimpleCommand") {
		visitSimpleCommand(
			node,
			pipelineIndex,
			context,
			state,
			visitScript,
		);
		return;
	}

	if (node.type === "FunctionDef") {
		state.ambiguous = ambiguous(
			"shell function definitions are not reviewable",
		);
		return;
	}

	const childContext: TraversalContext = {
		inheritedRedirections: [
			...context.inheritedRedirections,
			...redirectionsToTokens(node.redirections),
		],
		inheritedPipelineStdin:
			context.inheritedPipelineStdin || pipelineIndex > 0,
	};

	if (Array.isArray(node.condition)) {
		visitScript({ statements: node.condition }, childContext);
	}
	for (const clause of nodeArray(node, "clauses")) {
		const clauseNode = asNode(clause);
		if (Array.isArray(clauseNode?.condition)) {
			visitScript({ statements: clauseNode.condition }, childContext);
		}
		if (Array.isArray(clauseNode?.body)) {
			visitScript({ statements: clauseNode.body }, childContext);
		}
	}
	const body = asNode(node.body);
	if (body && Array.isArray(body.statements)) {
		visitScript(body, childContext);
	}
	if (Array.isArray(node.body)) {
		visitScript({ statements: node.body }, childContext);
	}
	if (Array.isArray(node.elseBody)) {
		visitScript({ statements: node.elseBody }, childContext);
	}
	for (const item of nodeArray(node, "items")) {
		const itemNode = asNode(item);
		if (Array.isArray(itemNode?.body)) {
			visitScript({ statements: itemNode.body }, childContext);
		}
	}
}

function analyzeAst(ast: unknown): ExtractionResult {
	const state: TraversalState = { invocations: [] };
	const emptyContext: TraversalContext = {
		inheritedRedirections: [],
		inheritedPipelineStdin: false,
	};

	const visitScript = (
		script: unknown,
		context: TraversalContext = emptyContext,
	): void => {
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
						context,
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
