declare module "@earendil-works/pi-coding-agent" {
	export interface ToolCallEvent {
		toolName: string;
		toolCallId?: string;
		input: Record<string, unknown>;
	}

	export interface ExtensionContext {
		cwd: string;
		hasUI: boolean;
		ui: {
			confirm(title: string, body: string): Promise<boolean>;
		};
	}

	export interface ToolCallBlockResult {
		block: true;
		reason?: string;
	}

	export type ToolCallResult = ToolCallBlockResult | undefined;

	export interface ExtensionAPI {
		on(
			eventName: "tool_call",
			handler: (
				event: ToolCallEvent,
				ctx: ExtensionContext,
			) => ToolCallResult | Promise<ToolCallResult>,
		): void;
	}
}
