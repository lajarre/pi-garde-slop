import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function githubWriteApproval(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") {
			return undefined;
		}

		return undefined;
	});
}
