import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallBlockResult,
	ToolCallEvent,
	ToolCallResult,
} from "@mariozechner/pi-coding-agent";
import githubWriteApproval from "../../index.ts";

export interface ExecCall {
	command: string;
	args: string[];
	options: unknown;
}

export interface FileReadCall {
	path: string;
}

export interface UICall {
	method: "confirm";
	title: string;
	body: string;
}

export interface HarnessOptions {
	cwd?: string;
	hasUI?: boolean;
	exec?: (
		command: string,
		args: string[],
		options: unknown,
	) => Promise<unknown> | unknown;
	readFile?: (path: string) => Promise<string> | string;
	confirm?: (title: string, body: string) => Promise<boolean> | boolean;
}

export interface Harness {
	ctx: ExtensionContext;
	execCalls: ExecCall[];
	fileReadCalls: FileReadCall[];
	uiCalls: UICall[];
	readFile(path: string): Promise<string>;
	runToolCall(event: ToolCallEvent): Promise<ToolCallResult>;
}

type ToolCallHandler = (
	event: ToolCallEvent,
	ctx: ExtensionContext,
) => ToolCallResult | Promise<ToolCallResult>;

function formatArgs(args: string[]): string {
	return args.length > 0 ? ` ${args.join(" ")}` : "";
}

export function createHarness(options: HarnessOptions = {}): Harness {
	const toolCallHandlers: ToolCallHandler[] = [];
	const execCalls: ExecCall[] = [];
	const fileReadCalls: FileReadCall[] = [];
	const uiCalls: UICall[] = [];

	const pi: ExtensionAPI = {
		on(eventName, handler) {
			if (eventName === "tool_call") {
				toolCallHandlers.push(handler);
			}
		},
	};

	const ctx: ExtensionContext = {
		cwd: options.cwd ?? process.cwd(),
		hasUI: options.hasUI ?? true,
		ui: {
			async confirm(title: string, body: string): Promise<boolean> {
				uiCalls.push({ method: "confirm", title, body });
				if (options.confirm) {
					return await options.confirm(title, body);
				}
				throw new Error(`Unexpected UI confirm call: ${title}`);
			},
		},
	};

	const harness: Harness = {
		ctx,
		execCalls,
		fileReadCalls,
		uiCalls,
		async readFile(path: string): Promise<string> {
			fileReadCalls.push({ path });
			if (options.readFile) {
				return await options.readFile(path);
			}
			throw new Error(`Unexpected file read call: ${path}`);
		},
		async runToolCall(event: ToolCallEvent): Promise<ToolCallResult> {
			for (const handler of toolCallHandlers) {
				const result = await handler(event, ctx);
				if ((result as ToolCallBlockResult | undefined)?.block) {
					return result;
				}
			}
			return undefined;
		},
	};

	Object.assign(pi, {
		async exec(
			command: string,
			args: string[] = [],
			optionsValue: unknown = undefined,
		): Promise<unknown> {
			execCalls.push({
				command,
				args: [...args],
				options: optionsValue,
			});
			if (options.exec) {
				return await options.exec(command, args, optionsValue);
			}
			throw new Error(
				`Unexpected exec call: ${command}${formatArgs(args)}`,
			);
		},
	});

	githubWriteApproval(pi);

	return harness;
}
