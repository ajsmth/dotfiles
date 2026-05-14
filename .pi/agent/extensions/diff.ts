import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { DynamicBorder, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";

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

type RecentCommit = {
	hash: string;
	shortHash: string;
	date: string;
	subject: string;
};

type AssistantReviewTarget = {
	text: string;
	label: string;
	preview: string;
};

type UserMessage = {
	role: "user";
	content?: unknown;
};

type ReviewSessionState = {
	target: AssistantReviewTarget;
	branchStartIndex: number;
};

type ReviewUpdateState = {
	target: AssistantReviewTarget;
	transcript: ReviewTranscriptTurn[];
};

type ReviewTranscriptTurn = {
	role: "user" | "assistant";
	text: string;
};

const MAX_REVIEW_CONTEXT_CHARS = 7000;

function isSessionMessageEntry(entry: unknown): entry is SessionMessageEntry {
	return !!entry && typeof entry === "object" && (entry as { type?: string }).type === "message";
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
	return !!message && typeof message === "object" && (message as { role?: string }).role === "assistant";
}

function isUserMessage(message: unknown): message is UserMessage {
	return !!message && typeof message === "object" && (message as { role?: string }).role === "user";
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

function extractMessageText(message: { content?: unknown }): string {
	return extractTextParts(message.content).join("\n").trim();
}

function getLastAssistantText(branch: unknown[]): { text?: string; incomplete?: string } {
	const targets = getRecentAssistantTargets(branch, 1);
	if (targets.length > 0) {
		return { text: targets[0].text };
	}

	let lastIncompleteReason: string | undefined;
	for (let i = branch.length - 1; i >= 0; i -= 1) {
		const entry = branch[i];
		if (!isSessionMessageEntry(entry) || !isAssistantMessage(entry.message)) {
			continue;
		}
		if (entry.message.stopReason && entry.message.stopReason !== "stop") {
			lastIncompleteReason ??= entry.message.stopReason;
		}
	}

	return lastIncompleteReason ? { incomplete: lastIncompleteReason } : {};
}

function summarizeAssistantText(text: string, maxLength = 90): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	if (singleLine.length <= maxLength) {
		return singleLine;
	}
	return `${singleLine.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function getRecentAssistantTargets(branch: unknown[], limit = 10): AssistantReviewTarget[] {
	const targets: AssistantReviewTarget[] = [];
	let count = 0;

	for (let i = branch.length - 1; i >= 0; i -= 1) {
		const entry = branch[i];
		if (!isSessionMessageEntry(entry) || !isAssistantMessage(entry.message)) {
			continue;
		}
		if (entry.message.stopReason && entry.message.stopReason !== "stop") {
			continue;
		}

		const text = extractTextParts(entry.message.content).join("\n").trim();
		if (!text) {
			continue;
		}

		count += 1;
		targets.push({
			text,
			label: `#${count}`,
			preview: summarizeAssistantText(text),
		});
		if (targets.length >= limit) {
			break;
		}
	}

	return targets;
}

function isInsideGitWorkTree(cwd: string): boolean {
	const insideWorkTree = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	return insideWorkTree.status === 0 && insideWorkTree.stdout.trim() === "true";
}

function hasHeadCommit(cwd: string): boolean {
	const hasHead = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "ignore", "ignore"],
	});
	return hasHead.status === 0;
}

function hasWorkingTreeChanges(cwd: string): boolean {
	const result = spawnSync("git", ["status", "--porcelain"], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	return result.status === 0 && result.stdout.trim() !== "";
}

function getGitOutput(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	return result.status === 0 ? result.stdout.trim() : "";
}

function getGitRoot(cwd: string): string | undefined {
	const root = getGitOutput(cwd, ["rev-parse", "--show-toplevel"]);
	return root || undefined;
}

function copyToClipboard(text: string): boolean {
	const result = spawnSync("pbcopy", {
		input: text,
		encoding: "utf8",
		stdio: ["pipe", "ignore", "ignore"],
	});
	return result.status === 0;
}

function getRepoDiffArgs(): string[] {
	return [];
}

function getRecentCommits(cwd: string, limit = 20): RecentCommit[] {
	if (!isInsideGitWorkTree(cwd) || !hasHeadCommit(cwd)) {
		return [];
	}

	const result = spawnSync("git", ["log", `-n${limit}`, "--date=short", "--pretty=format:%H%x09%h%x09%ad%x09%s"], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (result.status !== 0 || result.stdout.trim() === "") {
		return [];
	}

	return result.stdout
		.split("\n")
		.map((line) => {
			const [hash = "", shortHash = "", date = "", ...subjectParts] = line.split("\t");
			return {
				hash,
				shortHash,
				date,
				subject: subjectParts.join("\t").trim(),
			} satisfies RecentCommit;
		})
		.filter((commit) => commit.hash !== "" && commit.shortHash !== "");
}

function getCommitDiffBase(cwd: string, commitHash: string): { base: string; commit: string } | undefined {
	const parents = spawnSync("git", ["rev-list", "--parents", "-n", "1", commitHash], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (parents.status !== 0 || parents.stdout.trim() === "") {
		return undefined;
	}

	const parts = parents.stdout.trim().split(/\s+/);
	const commit = parts[0];
	const parent = parts[1];
	if (!commit) {
		return undefined;
	}

	if (parent) {
		return { base: parent, commit };
	}

	const emptyTree = spawnSync("git", ["hash-object", "-t", "tree", "/dev/null"], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (emptyTree.status !== 0 || emptyTree.stdout.trim() === "") {
		return undefined;
	}

	return { base: emptyTree.stdout.trim(), commit };
}

function isContiguousSelection(indices: number[]): boolean {
	if (indices.length <= 1) {
		return true;
	}

	for (let i = 1; i < indices.length; i += 1) {
		if (indices[i] !== indices[i - 1] + 1) {
			return false;
		}
	}
	return true;
}

function getCommitRangeDiffArgs(cwd: string, commits: RecentCommit[], indices: number[]): string[] | undefined {
	if (indices.length === 0) {
		return undefined;
	}

	const sorted = [...indices].sort((a, b) => a - b);
	if (!isContiguousSelection(sorted)) {
		return undefined;
	}

	const newest = commits[sorted[0]];
	const oldest = commits[sorted[sorted.length - 1]];
	if (!newest || !oldest) {
		return undefined;
	}

	const base = getCommitDiffBase(cwd, oldest.hash);
	if (!base) {
		return undefined;
	}

	return [base.base, newest.hash];
}

function formatCommitChoice(commit: RecentCommit): string {
	const subject = commit.subject || "(no subject)";
	return `${commit.shortHash} ${commit.date} ${subject}`;
}

async function selectCommitRange(ctx: any, commits: RecentCommit[]): Promise<number[] | undefined> {
	return (await ctx.ui.custom<number[] | null>((tui, theme, _kb, done) => {
		let cursor = 0;
		let top = 0;
		let status = "";
		const selected = new Set<number>();
		const maxVisible = Math.min(commits.length, 10);

		const clampViewport = () => {
			if (cursor < top) {
				top = cursor;
			}
			if (cursor >= top + maxVisible) {
				top = cursor - maxVisible + 1;
			}
		};

		const getSortedSelection = (): number[] => [...selected].sort((a, b) => a - b);

		return {
			render(width: number): string[] {
				clampViewport();
				const lines: string[] = [];
				const border = new DynamicBorder((s: string) => theme.fg("accent", s));
				lines.push(...border.render(width));
				lines.push(truncateToWidth(theme.fg("accent", theme.bold("No local changes — pick one or more commits")), width));
				lines.push(truncateToWidth(theme.fg("dim", "Space toggles • enter opens selected range • esc cancels"), width));
				lines.push(truncateToWidth(theme.fg("dim", "Selection must be contiguous; the diff spans oldest → newest."), width));
				if (status) {
					lines.push(truncateToWidth(theme.fg("warning", status), width));
				}

				const visible = commits.slice(top, top + maxVisible);
				for (let offset = 0; offset < visible.length; offset += 1) {
					const index = top + offset;
					const commit = visible[offset];
					const prefix = index === cursor ? "›" : " ";
					const mark = selected.has(index) ? "[x]" : "[ ]";
					const text = `${prefix} ${mark} ${formatCommitChoice(commit)}`;
					const line = index === cursor ? theme.fg("accent", text) : text;
					lines.push(truncateToWidth(line, width));
				}

				if (commits.length > maxVisible) {
					lines.push(truncateToWidth(theme.fg("dim", `${top + 1}-${Math.min(top + maxVisible, commits.length)} of ${commits.length}`), width));
				}

				lines.push(...border.render(width));
				return lines;
			},
			invalidate() {},
			handleInput(data: string) {
				status = "";
				if (matchesKey(data, Key.up) || data === "k") {
					cursor = Math.max(0, cursor - 1);
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.down) || data === "j") {
					cursor = Math.min(commits.length - 1, cursor + 1);
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.space)) {
					if (selected.has(cursor)) {
						selected.delete(cursor);
					} else {
						selected.add(cursor);
					}
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.enter)) {
					if (selected.size === 0) {
						done([cursor]);
						return;
					}
					const sorted = getSortedSelection();
					if (!isContiguousSelection(sorted)) {
						status = "Select a contiguous commit range before pressing enter.";
						tui.requestRender();
						return;
					}
					done(sorted);
					return;
				}
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
					done(null);
				}
			},
		};
	})) ?? undefined;
}

function formatAssistantReviewInput(target: AssistantReviewTarget): string {
	return [
		`# Review Target: Assistant Response ${target.label}`,
		"",
		"Leave annotations on the lines you want to question or change, then paste the copied review back into pi to start a tracked review discussion.",
		"Use /review update later to regenerate a revised version of this response.",
		"",
		"---",
		"",
		target.text,
	].join("\n");
}

async function pickAssistantReviewTarget(ctx: any, targets: AssistantReviewTarget[]): Promise<AssistantReviewTarget | undefined> {
	const labels = targets.map((target) => `${target.label} ${target.preview}`);
	const selection = await ctx.ui.select("Pick an assistant response to review", labels);
	if (!selection) {
		return undefined;
	}

	const index = labels.indexOf(selection);
	return index >= 0 ? targets[index] : undefined;
}

function truncateReviewContext(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length <= MAX_REVIEW_CONTEXT_CHARS) {
		return trimmed;
	}
	return `${trimmed.slice(0, MAX_REVIEW_CONTEXT_CHARS)}\n\n[Original response truncated for context]`;
}

function normalizeReviewFeedback(feedback: string): string {
	const trimmed = feedback.trim();
	const tagged = trimmed.match(/<review>\s*([\s\S]*?)\s*<\/review>/i);
	return tagged?.[1]?.trim() || trimmed;
}

function formatReviewDiscussionInput(feedback: string): string {
	return [
		"Review comments about your earlier response:",
		"",
		normalizeReviewFeedback(feedback),
	].join("\n");
}

function getReviewTranscript(branch: unknown[], startIndex: number): ReviewTranscriptTurn[] {
	const transcript: ReviewTranscriptTurn[] = [];
	for (let i = Math.max(0, startIndex); i < branch.length; i += 1) {
		const entry = branch[i];
		if (!isSessionMessageEntry(entry)) {
			continue;
		}

		if (isUserMessage(entry.message)) {
			const text = extractMessageText(entry.message);
			if (text) {
				transcript.push({ role: "user", text });
			}
			continue;
		}

		if (!isAssistantMessage(entry.message)) {
			continue;
		}
		if (entry.message.stopReason && entry.message.stopReason !== "stop") {
			continue;
		}

		const text = extractMessageText(entry.message);
		if (text) {
			transcript.push({ role: "assistant", text });
		}
	}
	return transcript;
}

function formatReviewTranscript(transcript: ReviewTranscriptTurn[]): string {
	if (transcript.length === 0) {
		return "(No tracked review discussion yet.)";
	}

	return transcript
		.map((turn) => `${turn.role === "user" ? "User" : "Assistant"}:\n${turn.text}`)
		.join("\n\n");
}

function formatActiveReviewContext(state: ReviewSessionState): string {
	return [
		"[ASSISTANT REVIEW MODE ACTIVE]",
		"The user is discussing a previous assistant response and wants that discussion tracked until /review update or /review clear.",
		"Answer the user's current questions or concerns directly and conversationally.",
		"Do not regenerate or rewrite the full original response unless /review update is invoked or the user explicitly asks for a rewrite.",
		"Keep the same review target in mind for the whole discussion.",
		`Review target: Assistant Response ${state.target.label}`,
		"",
		"Original assistant response under review:",
		"",
		truncateReviewContext(state.target.text),
	].join("\n");
}

function formatReviewUpdatePrompt(state: ReviewUpdateState): string {
	return [
		"Revise your earlier assistant response using the tracked review discussion below.",
		"Produce a new standalone response that replaces the original target response.",
		"Incorporate the corrections, clarifications, and agreed changes from the discussion.",
		"Preserve the original scope unless the discussion explicitly changed it.",
		"Return only the revised response.",
		"Do not explain the revision process or summarize what changed.",
		"",
		"Original assistant response:",
		"",
		state.target.text,
		"",
		"Tracked review discussion:",
		"",
		formatReviewTranscript(state.transcript),
	].join("\n");
}

function formatReviewUpdateContext(state: ReviewUpdateState): string {
	return [
		"[ASSISTANT REVIEW UPDATE]",
		"This turn should produce a revised replacement for the earlier assistant response under review.",
		"Use the tracked review discussion to improve the response.",
		"Return only the revised response, with no commentary about the revision.",
		`Review target: Assistant Response ${state.target.label}`,
	].join("\n");
}

async function launchDif(ctx: any, args: string[], input?: string, extraEnv: Record<string, string> = {}, cwd?: string): Promise<boolean> {
	let launchError = "";
	const exitCode = await ctx.ui.custom<number | null>((tui, _theme, _kb, done) => {
		const useTmuxPopup = !!process.env.TMUX;
		if (!useTmuxPopup) {
			tui.stop();
		}
		let popupInputDir: string | undefined;
		let historyDir: string | undefined;
		let result: ReturnType<typeof spawnSync> | undefined;
		try {
			const workDir = cwd || ctx.cwd || process.cwd();
			historyDir = mkdtempSync(path.join(os.tmpdir(), "pi-dif-history-"));
			const launchEnv = { ...extraEnv, REVDIFF_HISTORY_DIR: historyDir };
			if (useTmuxPopup) {
				const popupArgs = ["display-popup", "-E", "-d", workDir, "-w", "90%", "-h", "90%", "-T", "dif"];
				for (const [key, value] of Object.entries(launchEnv)) {
					popupArgs.push("-e", `${key}=${value}`);
				}

				if (input === undefined) {
					result = spawnSync("tmux", [...popupArgs, "dif", ...args], {
						cwd: workDir,
						encoding: "utf8",
						stdio: ["ignore", "inherit", "inherit"],
					});
				} else {
					popupInputDir = mkdtempSync(path.join(os.tmpdir(), "pi-dif-popup-"));
					const popupInputPath = path.join(popupInputDir, "input.txt");
					writeFileSync(popupInputPath, input, "utf8");
					result = spawnSync(
						"tmux",
						[
							...popupArgs,
							"-e",
							`DIF_INPUT_FILE=${popupInputPath}`,
							"sh",
							"-lc",
							'dif "$@" < "$DIF_INPUT_FILE"',
							"sh",
							...args,
						],
						{
							cwd: workDir,
							encoding: "utf8",
							stdio: ["ignore", "inherit", "inherit"],
						},
					);
				}
			} else {
				process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
				result = spawnSync("dif", args, {
					cwd: workDir,
					env: { ...process.env, ...launchEnv },
					input,
					stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
					encoding: "utf8",
				});
			}

			if (result?.error) {
				launchError = result.error.message;
			}
		} finally {
			if (popupInputDir) {
				rmSync(popupInputDir, { recursive: true, force: true });
			}
			if (historyDir) {
				rmSync(historyDir, { recursive: true, force: true });
			}
			if (!useTmuxPopup) {
				process.stdout.write("\x1b[?1049l");
				tui.start();
				tui.requestRender(true);
			}
		}
		done(result?.status ?? (result?.error ? 1 : 0));
		return { render: () => [], invalidate() {} };
	});

	if (launchError) {
		ctx.ui.notify(`Failed to launch dif: ${launchError}`, "error");
		return false;
	}

	if ((exitCode ?? 0) !== 0) {
		ctx.ui.notify(`dif exited with code ${exitCode ?? 1}`, "warning");
		return false;
	}

	ctx.ui.notify("Copied dif annotations to the clipboard. Paste them back when ready.", "success");
	return true;
}

export default function diffExtension(pi: ExtensionAPI): void {
	pi.registerCommand("diff", {
		description: "Review current repo changes with dif, or pick a recent commit when the worktree is clean",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/diff requires the interactive TUI", "warning");
				return;
			}

			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current turn to finish before launching /diff", "warning");
				return;
			}

			const cwd = ctx.cwd || process.cwd();
			const rawArgs = (args || "").trim().toLowerCase();
			if (rawArgs === "debug") {
				const debugLines = [
					`ctx.cwd: ${ctx.cwd || "<unset>"}`,
					`process.cwd(): ${process.cwd()}`,
					`inside git worktree: ${isInsideGitWorkTree(cwd)}`,
					`git root: ${getGitRoot(cwd) || "<none>"}`,
					`has HEAD: ${hasHeadCommit(cwd)}`,
					`has working tree changes: ${hasWorkingTreeChanges(cwd)}`,
					"",
					"git status --short:",
					getGitOutput(cwd, ["status", "--short", "--untracked-files=all"]) || "<empty>",
				].join("\n");
				const copied = copyToClipboard(debugLines);
				ctx.ui.notify(copied ? "Copied /diff debug info to clipboard. Paste it back here." : debugLines, "info");
				return;
			}
			if (!isInsideGitWorkTree(cwd)) {
				await launchDif(ctx, getRepoDiffArgs(), undefined, {}, cwd);
				return;
			}

			if (hasWorkingTreeChanges(cwd) || !hasHeadCommit(cwd)) {
				await launchDif(ctx, getRepoDiffArgs(), undefined, {}, cwd);
				return;
			}

			const commits = getRecentCommits(cwd);
			if (commits.length === 0) {
				ctx.ui.notify("No working tree changes and no recent commits found.", "info");
				return;
			}

			const selectedIndices = await selectCommitRange(ctx, commits);
			if (!selectedIndices || selectedIndices.length === 0) {
				return;
			}

			const diffArgs = getCommitRangeDiffArgs(cwd, commits, selectedIndices);
			if (!diffArgs) {
				ctx.ui.notify("Couldn't build a diff for the selected commit range.", "warning");
				return;
			}

			await launchDif(ctx, diffArgs, undefined, {
				DIF_CLIPBOARD_MODE: "commit-review",
			}, cwd);
		},
	});

	let pendingReviewCapture: AssistantReviewTarget | undefined;
	let activeReview: ReviewSessionState | undefined;
	let pendingReviewUpdate: ReviewUpdateState | undefined;

	const clearReviewState = (): void => {
		pendingReviewCapture = undefined;
		activeReview = undefined;
		pendingReviewUpdate = undefined;
	};

	const handleReviewStatus = (ctx: any): void => {
		if (pendingReviewCapture) {
			ctx.ui.notify(
				[
					`Awaiting pasted review feedback for assistant response ${pendingReviewCapture.label}.`,
					`Preview: ${pendingReviewCapture.preview}`,
					"Paste the copied dif annotations to start the tracked review discussion.",
				].join("\n"),
				"info",
			);
			return;
		}

		if (!activeReview) {
			ctx.ui.notify("No active review thread. Use /review to start one.", "info");
			return;
		}

		const transcript = getReviewTranscript(ctx.sessionManager.getBranch(), activeReview.branchStartIndex);
		ctx.ui.notify(
			[
				`Active review target: Assistant Response ${activeReview.target.label}`,
				`Preview: ${activeReview.target.preview}`,
				`Tracked turns: ${transcript.length}`,
				"Run /review update to regenerate a revised version, or /review clear to discard it.",
			].join("\n"),
			"info",
		);
	};

	const startAssistantReview = async (commandName: string, rawArgs: string | undefined, ctx: any, defaultMode: "last" | "pick"): Promise<void> => {
		if (!ctx.hasUI) {
			ctx.ui.notify(`/${commandName} requires the interactive TUI`, "warning");
			return;
		}

		if (!ctx.isIdle()) {
			ctx.ui.notify(`Wait for the current turn to finish before launching /${commandName}`, "warning");
			return;
		}

		const branch = ctx.sessionManager.getBranch();
		const targets = getRecentAssistantTargets(branch, 20);
		if (targets.length === 0) {
			const { incomplete } = getLastAssistantText(branch);
			if (incomplete) {
				ctx.ui.notify(`Last assistant message is incomplete (${incomplete})`, "warning");
				return;
			}
			ctx.ui.notify("No assistant message with text content found on this branch", "info");
			return;
		}

		const args = (rawArgs || "").trim().toLowerCase();
		let target: AssistantReviewTarget | undefined;
		if (args === "" && defaultMode === "last") {
			target = targets[0];
		} else if (args === "" || args === "pick") {
			target = await pickAssistantReviewTarget(ctx, targets);
		} else if (args === "last") {
			target = targets[0];
		} else if (/^\d+$/.test(args)) {
			const index = Number.parseInt(args, 10);
			if (!Number.isFinite(index) || index < 1 || index > targets.length) {
				ctx.ui.notify(`Choose a response number between 1 and ${targets.length}.`, "warning");
				return;
			}
			target = targets[index - 1];
		} else {
			ctx.ui.notify(`Usage: /${commandName} [last|pick|<n>|status|update|clear]`, "info");
			return;
		}

		if (!target) {
			return;
		}

		const reviewed = await launchDif(
			ctx,
			["--stdin", "--stdin-name", `assistant-response-${target.label.replace(/^#/, "")}.md`],
			formatAssistantReviewInput(target),
			{ DIF_CLIPBOARD_MODE: "assistant-review" },
			ctx.cwd || process.cwd(),
		);
		if (!reviewed) {
			return;
		}

		pendingReviewUpdate = undefined;
		activeReview = undefined;
		pendingReviewCapture = target;
		ctx.ui.notify(
			`Paste your review feedback to start a tracked discussion for assistant response ${target.label}. Run /review update later to regenerate it.`,
			"info",
		);
	};

	const handleReviewUpdate = async (ctx: any): Promise<void> => {
		if (!ctx.isIdle()) {
			ctx.ui.notify("Wait for the current turn to finish before running /review update", "warning");
			return;
		}

		if (pendingReviewCapture && !activeReview) {
			ctx.ui.notify("Paste your copied review feedback first so I can track the review discussion before updating.", "info");
			return;
		}

		if (!activeReview) {
			ctx.ui.notify("No active review thread. Use /review to start one.", "info");
			return;
		}

		const transcript = getReviewTranscript(ctx.sessionManager.getBranch(), activeReview.branchStartIndex);
		const updateState: ReviewUpdateState = {
			target: activeReview.target,
			transcript,
		};
		pendingReviewUpdate = updateState;
		pendingReviewCapture = undefined;
		activeReview = undefined;
		pi.sendUserMessage(formatReviewUpdatePrompt(updateState));
		ctx.ui.notify(`Regenerating a revised version of assistant response ${updateState.target.label} from the tracked review discussion...`, "info");
	};

	const reviewAssistant = async (commandName: string, rawArgs: string | undefined, ctx: any, defaultMode: "last" | "pick"): Promise<void> => {
		const args = (rawArgs || "").trim().toLowerCase();
		if (args === "status") {
			handleReviewStatus(ctx);
			return;
		}
		if (args === "clear") {
			const hadState = !!pendingReviewCapture || !!activeReview;
			clearReviewState();
			ctx.ui.notify(hadState ? "Cleared the active review thread." : "No active review thread to clear.", "info");
			return;
		}
		if (args === "update") {
			await handleReviewUpdate(ctx);
			return;
		}

		await startAssistantReview(commandName, rawArgs, ctx, defaultMode);
	};

	pi.on("input", async (event, ctx) => {
		const text = event.text.trim();
		if (text === "") {
			return { action: "continue" };
		}

		if (text.startsWith("/")) {
			return { action: "continue" };
		}

		if (!pendingReviewCapture) {
			return { action: "continue" };
		}

		activeReview = {
			target: pendingReviewCapture,
			branchStartIndex: ctx.sessionManager.getBranch().length,
		};
		pendingReviewCapture = undefined;
		ctx.ui.notify(
			`Tracking review discussion for assistant response ${activeReview.target.label}. Run /review update when you're ready to regenerate it.`,
			"info",
		);
		return {
			action: "transform",
			text: formatReviewDiscussionInput(event.text),
		};
	});

	pi.on("before_agent_start", async () => {
		if (pendingReviewUpdate) {
			const state = pendingReviewUpdate;
			pendingReviewUpdate = undefined;
			return {
				message: {
					customType: "assistant-review-context",
					content: formatReviewUpdateContext(state),
					display: false,
				},
			};
		}

		if (!activeReview) {
			return undefined;
		}

		return {
			message: {
				customType: "assistant-review-context",
				content: formatActiveReviewContext(activeReview),
				display: false,
			},
		};
	});

	pi.registerCommand("rev", {
		description: "Review the last assistant response with dif, then track follow-up discussion until /review update",
		handler: async (args, ctx) => {
			await reviewAssistant("rev", args, ctx, "last");
		},
	});

	pi.registerCommand("review", {
		description: "Review a recent assistant response, track follow-up discussion, and regenerate it later with /review update",
		handler: async (args, ctx) => {
			await reviewAssistant("review", args, ctx, "pick");
		},
	});
}
