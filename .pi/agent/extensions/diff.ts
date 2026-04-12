import { spawnSync } from "node:child_process";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type TextBlock = {
	type: "text";
	text: string;
};

type AssistantMessage = {
	role: "assistant";
	stopReason?: string;
	content?: unknown;
};

type SessionMessageEntry = {
	type: "message";
	message: {
		role?: string;
		stopReason?: string;
		content?: unknown;
	};
};

function isSessionMessageEntry(entry: unknown): entry is SessionMessageEntry {
	return !!entry && typeof entry === "object" && (entry as { type?: string }).type === "message";
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
	return !!message && typeof message === "object" && (message as { role?: string }).role === "assistant";
}

function extractTextParts(content: unknown): string[] {
	if (!Array.isArray(content)) {
		return [];
	}

	return content
		.filter((block): block is TextBlock => {
			return !!block && typeof block === "object" && (block as { type?: string }).type === "text" && typeof (block as { text?: unknown }).text === "string";
		})
		.map((block) => block.text);
}

function getLastAssistantText(branch: unknown[]): { text?: string; incomplete?: string } {
	for (let i = branch.length - 1; i >= 0; i -= 1) {
		const entry = branch[i];
		if (!isSessionMessageEntry(entry) || !isAssistantMessage(entry.message)) {
			continue;
		}

		if (entry.message.stopReason && entry.message.stopReason !== "stop") {
			return { incomplete: entry.message.stopReason };
		}

		const text = extractTextParts(entry.message.content).join("\n").trim();
		if (text) {
			return { text };
		}
	}

	return {};
}

async function launchDif(ctx: any, args: string[], input?: string): Promise<void> {
	let launchError = "";
	const exitCode = await ctx.ui.custom<number | null>((tui, _theme, _kb, done) => {
		tui.stop();
		process.stdout.write("\x1b[2J\x1b[H");
		const result = spawnSync("dif", args, {
			cwd: process.cwd(),
			env: process.env,
			input,
			stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
			encoding: "utf8",
		});
		if (result.error) {
			launchError = result.error.message;
		}
		tui.start();
		tui.requestRender(true);
		done(result.status ?? (result.error ? 1 : 0));
		return { render: () => [], invalidate() {} };
	});

	if (launchError) {
		ctx.ui.notify(`Failed to launch dif: ${launchError}`, "error");
		return;
	}

	if ((exitCode ?? 0) !== 0) {
		ctx.ui.notify(`dif exited with code ${exitCode ?? 1}`, "warning");
		return;
	}

	ctx.ui.notify("Copied dif annotations to the clipboard. Paste them back when ready.", "success");
}

export default function diffExtension(pi: ExtensionAPI): void {
	pi.registerCommand("diff", {
		description: "Review the current repo changes with dif and copy annotations to the clipboard",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/diff requires the interactive TUI", "warning");
				return;
			}

			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current turn to finish before launching /diff", "warning");
				return;
			}

			await launchDif(ctx, []);
		},
	});

	pi.registerCommand("rev", {
		description: "Review the last assistant response with dif and copy annotations to the clipboard",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/rev requires the interactive TUI", "warning");
				return;
			}

			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current turn to finish before launching /rev", "warning");
				return;
			}

			const { text, incomplete } = getLastAssistantText(ctx.sessionManager.getBranch());
			if (incomplete) {
				ctx.ui.notify(`Last assistant message is incomplete (${incomplete})`, "warning");
				return;
			}
			if (!text) {
				ctx.ui.notify("No assistant message with text content found on this branch", "info");
				return;
			}

			await launchDif(ctx, ["--stdin", "--stdin-name", "assistant.md"], text);
		},
	});
}
