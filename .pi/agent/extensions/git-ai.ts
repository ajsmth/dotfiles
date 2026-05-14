import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BorderedLoader, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

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

type CommandResult = {
	status: number | null;
	stdout: string;
	stderr: string;
	error?: string;
};

type GitStatus = {
	hasChanges: boolean;
	hasStaged: boolean;
	hasUnstaged: boolean;
};

type CommitDraft = {
	subject: string;
	body: string;
};

type PrDraft = {
	title: string;
	body: string;
};

type GeneratedPrDraft = {
	draft: PrDraft;
	usedFallback: boolean;
};

type ExistingPrDetails = {
	title: string;
	body: string;
};

type ReviewTarget = "coderabbit" | "codex";

type PrMetadata = {
	repo: string;
	branch: string;
	number: number;
	url?: string;
};

type ReviewAnchor = {
	target: ReviewTarget;
	id: number;
	author: string;
	body: string;
	createdAt: string;
	updatedAt: string;
	url?: string;
};

type ReviewSnapshotItem = {
	key: string;
	kind: "issue_comment" | "review_comment" | "review";
	id: number;
	author: string;
	body: string;
	createdAt: string;
	updatedAt: string;
	url?: string;
	path?: string;
	line?: number;
	state?: string;
};

type ReviewSnapshot = {
	fetchedAt: string;
	repo: string;
	prNumber: number;
	prUrl?: string;
	mode?: "open" | "all";
	scope?: "pr" | "bot_reviews";
	anchorKey?: string;
	anchors?: ReviewAnchor[];
	targets?: ReviewTarget[];
	items: ReviewSnapshotItem[];
};

type ReviewSnapshotPaths = {
	dir: string;
	latestPath: string;
	previousPath: string;
	deltaPath: string;
};

type ReviewSnapshotDelta = {
	added: ReviewSnapshotItem[];
	changed: ReviewSnapshotItem[];
};

type PrFeedbackComment = {
	id: string;
	author: string;
	body: string;
	createdAt: string;
	updatedAt: string;
	url?: string;
	path?: string;
	line?: number;
};

type PrFeedbackResult = {
	metadata: PrMetadata;
	comments: PrFeedbackComment[];
};

type PrFeedbackOptions = {
	apply: boolean;
	prNumber?: number;
	valid: boolean;
};

type PrDiscussionData = {
	metadata: PrMetadata;
	issueComments: Array<Record<string, unknown>>;
	reviewComments: Array<Record<string, unknown>>;
	reviews: Array<Record<string, unknown>>;
};

const REVIEW_SNAPSHOTS_ROOT = path.join(os.homedir(), ".local", "state", "pi", "reviews");
const REVIEW_TRIGGER_TO_TARGET: Record<string, ReviewTarget> = {
	"@coderabbit review": "coderabbit",
	"/codex review": "codex",
};
const REVIEW_TRIGGER_BODIES = new Set(Object.keys(REVIEW_TRIGGER_TO_TARGET));
const REVIEW_BOT_AUTHOR_MATCHERS: Record<ReviewTarget, RegExp[]> = {
	coderabbit: [/coderabbit/i],
	codex: [/\bcodex\b/i, /openai/i, /copilot/i],
};
const REVIEW_BOT_BODY_MATCHERS: Record<ReviewTarget, RegExp[]> = {
	coderabbit: [/coderabbit/i, /actionable comments posted/i, /duplicate comments/i],
	codex: [/code review by gpt/i, /\bgpt[- ]?\d/i, /\bgpt\b/i, /\bcodex\b/i],
};
const REVIEW_IGNORED_BODY_MATCHERS = [
	/<!--\s*This is an auto-generated reply by CodeRabbit\s*-->/i,
	/<summary>✅ Actions performed<\/summary>[\s\S]*?Review triggered\./i,
];
const REVIEW_ROUND_MAX_GAP_MS = 2 * 60 * 1000;
const PR_FEEDBACK_BATCH_MAX_GAP_MS = 10 * 60 * 1000;
const PR_FEEDBACK_BOT_MATCHERS = [
	/coderabbit/i,
	/code review by gpt[- ]?5 codex/i,
	/gpt[- ]?5 codex/i,
	/code review by gpt\s*5(?:\.\d+)?/i,
	/\bgpt\s*5(?:\.\d+)?\b/i,
	/\bcodex\b/i,
	/github[- ]copilot/i,
	/\bcopilot\b/i,
];

function runCommand(command: string, args: string[], cwd: string, input?: string): CommandResult {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		input,
		stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
	});

	return {
		status: result.status,
		stdout: result.stdout || "",
		stderr: result.stderr || "",
		error: result.error?.message,
	};
}

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

function getLastAssistantText(entries: unknown[]): { text?: string; incomplete?: string } {
	let lastIncompleteReason: string | undefined;

	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (!isSessionMessageEntry(entry) || !isAssistantMessage(entry.message)) {
			continue;
		}

		if (entry.message.stopReason && entry.message.stopReason !== "stop") {
			lastIncompleteReason ??= entry.message.stopReason;
			continue;
		}

		const text = extractTextParts(entry.message.content).join("\n").trim();
		if (text) {
			return { text };
		}
	}

	return lastIncompleteReason ? { incomplete: lastIncompleteReason } : {};
}

function hasCommand(command: string, cwd: string): boolean {
	const result = runCommand("sh", ["-lc", `command -v ${command}`], cwd);
	return result.status === 0 && result.stdout.trim() !== "";
}

function isInsideGitRepo(cwd: string): boolean {
	const result = runCommand("git", ["rev-parse", "--is-inside-work-tree"], cwd);
	return result.status === 0 && result.stdout.trim() === "true";
}

function getCurrentBranch(cwd: string): string {
	const result = runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd);
	return result.status === 0 ? result.stdout.trim() : "HEAD";
}

function getRepoRoot(cwd: string): string {
	const result = runCommand("git", ["rev-parse", "--show-toplevel"], cwd);
	return result.status === 0 ? result.stdout.trim() : cwd;
}

function slugify(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "repo";
}

function getReviewSnapshotPaths(cwd: string, prNumber: number, suffix?: string): ReviewSnapshotPaths {
	const repoRoot = getRepoRoot(cwd);
	const repoBase = path.basename(repoRoot);
	const repoHash = createHash("sha1").update(repoRoot).digest("hex").slice(0, 10);
	const dir = path.join(REVIEW_SNAPSHOTS_ROOT, `${slugify(repoBase)}-${repoHash}`);
	const baseName = suffix ? `pr-${prNumber}-${slugify(suffix)}` : `pr-${prNumber}`;
	return {
		dir,
		latestPath: path.join(dir, `${baseName}-latest.json`),
		previousPath: path.join(dir, `${baseName}-previous.json`),
		deltaPath: path.join(dir, `${baseName}-review-delta.md`),
	};
}

async function readReviewSnapshot(snapshotPath: string): Promise<ReviewSnapshot | undefined> {
	const text = await readFile(snapshotPath, "utf8").catch(() => "");
	if (text.trim() === "") {
		return undefined;
	}

	try {
		return JSON.parse(text) as ReviewSnapshot;
	} catch {
		return undefined;
	}
}

async function writeReviewSnapshot(snapshotPath: string, snapshot: ReviewSnapshot): Promise<void> {
	await mkdir(path.dirname(snapshotPath), { recursive: true });
	await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

async function writeReviewDeltaFile(deltaPath: string, markdown: string): Promise<void> {
	await mkdir(path.dirname(deltaPath), { recursive: true });
	await writeFile(deltaPath, `${markdown.trimEnd()}\n`, "utf8");
}

function parseJsonObject<T>(text: string): T | undefined {
	if (text.trim() === "") {
		return undefined;
	}

	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

function normalizeReviewBody(body: unknown): string {
	return typeof body === "string" ? body.trim() : "";
}

function normalizeReviewAuthor(user: unknown): string {
	if (!user || typeof user !== "object") {
		return "unknown";
	}
	const login = (user as { login?: unknown }).login;
	return typeof login === "string" && login.trim() !== "" ? login : "unknown";
}

function getPrMetadata(cwd: string, prNumber?: number): PrMetadata | undefined {
	if (!hasCommand("gh", cwd)) {
		return undefined;
	}

	const branch = getCurrentBranch(cwd);
	const repoResult = runCommand("gh", ["repo", "view", "--json", "nameWithOwner"], cwd);
	const prSelector = prNumber ? String(prNumber) : branch;
	const prResult = runCommand("gh", ["pr", "view", prSelector, "--json", "number,url"], cwd);
	const repo = parseJsonObject<{ nameWithOwner?: unknown }>(repoResult.stdout)?.nameWithOwner;
	const pr = parseJsonObject<{ number?: unknown; url?: unknown }>(prResult.stdout);
	if (typeof repo !== "string" || typeof pr?.number !== "number") {
		return undefined;
	}

	return {
		repo,
		branch,
		number: pr.number,
		url: typeof pr.url === "string" ? pr.url : undefined,
	};
}

function buildReviewSnapshotDelta(previous: ReviewSnapshot | undefined, latest: ReviewSnapshot): ReviewSnapshotDelta {
	const previousItems = new Map((previous?.items || []).map((item) => [item.key, item]));
	const added: ReviewSnapshotItem[] = [];
	const changed: ReviewSnapshotItem[] = [];

	for (const item of latest.items) {
		const existing = previousItems.get(item.key);
		if (!existing) {
			added.push(item);
			continue;
		}
		if (existing.body !== item.body || existing.updatedAt !== item.updatedAt || existing.state !== item.state) {
			changed.push(item);
		}
	}

	return { added, changed };
}

function formatReviewSnapshotItem(item: ReviewSnapshotItem): string {
	const location = item.path ? `${item.path}${typeof item.line === "number" ? `:${item.line}` : ""}` : "general";
	const heading = item.kind === "review_comment"
		? `### Inline comment — @${item.author} — ${location}`
		: item.kind === "review"
			? `### Review summary — @${item.author}${item.state ? ` — ${item.state}` : ""}`
			: `### Comment — @${item.author}`;
		const details = [
			heading,
			item.url ? `URL: ${item.url}` : undefined,
			`Updated: ${item.updatedAt || item.createdAt}`,
			"",
			item.body,
		].filter((line): line is string => typeof line === "string" && line !== "");
	return details.join("\n");
}

function summarizeReviewAuthors(items: ReviewSnapshotItem[]): string {
	const counts = new Map<string, number>();
	for (const item of items) {
		counts.set(item.author, (counts.get(item.author) || 0) + 1);
	}

	return Array.from(counts.entries())
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([author, count]) => `@${author}: ${count}`)
		.join(", ");
}

function formatReviewDeltaMarkdown(snapshot: ReviewSnapshot, delta: ReviewSnapshotDelta): string {
	const title = snapshot.scope === "bot_reviews" ? "# Bot Review Delta" : "# PR Review Delta";
	const sections: string[] = [
		title,
		"",
		"Keep only the comments you want to send back to the LLM, then save to copy them to the clipboard.",
		snapshot.prUrl ? `PR: ${snapshot.prUrl}` : `PR #${snapshot.prNumber}`,
		`Fetched: ${snapshot.fetchedAt}`,
	];
	if (snapshot.scope === "bot_reviews" && snapshot.anchors && snapshot.anchors.length > 0) {
		sections.push(`Anchors: ${formatReviewAnchorSummary(snapshot.anchors)}`);
	}

	if (delta.added.length > 0) {
		sections.push("", `## New comments (${delta.added.length})`);
		for (const item of delta.added) {
			sections.push("", formatReviewSnapshotItem(item));
		}
	}

	if (delta.changed.length > 0) {
		sections.push("", `## Updated comments (${delta.changed.length})`);
		for (const item of delta.changed) {
			sections.push("", formatReviewSnapshotItem(item));
		}
	}

	if (delta.added.length === 0 && delta.changed.length === 0) {
		sections.push("", "No new or updated review comments since the previous fetch.");
	}

	return `${sections.join("\n").trim()}\n`;
}

function formatCurrentReviewMarkdown(snapshot: ReviewSnapshot): string {
	const modeLabel = snapshot.scope === "bot_reviews"
		? "latest bot review comments"
		: snapshot.mode === "all"
			? "all fetched review comments"
			: "currently open review comments";
	const title = snapshot.scope === "bot_reviews" ? "# Current Bot Review Comments" : "# Current PR Review Comments";
	const sections: string[] = [
		title,
		"",
		"Keep only the comments you want to send back to the LLM, then save to copy them to the clipboard.",
		snapshot.prUrl ? `PR: ${snapshot.prUrl}` : `PR #${snapshot.prNumber}`,
		`Fetched: ${snapshot.fetchedAt}`,
		`Showing: ${modeLabel}`,
	];
	if (snapshot.scope === "bot_reviews" && snapshot.anchors && snapshot.anchors.length > 0) {
		sections.push(`Anchors: ${formatReviewAnchorSummary(snapshot.anchors)}`);
	}

	if (snapshot.items.length > 0) {
		sections.push("", `## Comments (${snapshot.items.length})`);
		for (const item of snapshot.items) {
			sections.push("", formatReviewSnapshotItem(item));
		}
	} else {
		sections.push("", "No review comments are available in the current snapshot.");
	}

	return `${sections.join("\n").trim()}\n`;
}

function formatReviewDiffInput(markdown: string): string {
	return [
		"Select the review comments you want to send back to the LLM.",
		"Leave annotations on the lines or sections you want included, then paste the copied review back into pi.",
		"",
		"---",
		"",
		markdown,
	].join("\n");
}

async function launchDif(ctx: any, args: string[], input?: string, extraEnv: Record<string, string> = {}, cwd?: string): Promise<boolean> {
	let launchError = "";
	const exitCode = await ctx.ui.custom<number | null>((tui, _theme, _kb, done) => {
		const workDir = cwd || process.cwd();
		const useTmuxPopup = !!process.env.TMUX;
		if (!useTmuxPopup) {
			tui.stop();
		}
		let popupInputDir: string | undefined;
		let result: ReturnType<typeof spawnSync> | undefined;
		try {
			if (useTmuxPopup) {
				const popupArgs = ["display-popup", "-E", "-d", workDir, "-w", "90%", "-h", "90%", "-T", "dif"];
				for (const [key, value] of Object.entries(extraEnv)) {
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
					env: { ...process.env, ...extraEnv },
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

	ctx.ui.notify("Copied dif annotations to the clipboard. Paste them back into pi when ready.", "success");
	return true;
}

function copyToClipboard(content: string): boolean {
	const copied = spawnSync("pbcopy", {
		input: content,
		encoding: "utf8",
		stdio: ["pipe", "ignore", "ignore"],
	});
	return copied.status === 0;
}

function getGitStatus(cwd: string): GitStatus {
	const result = runCommand("git", ["status", "--porcelain"], cwd);
	if (result.status !== 0) {
		return {
			hasChanges: false,
			hasStaged: false,
			hasUnstaged: false,
		};
	}

	let hasChanges = false;
	let hasStaged = false;
	let hasUnstaged = false;

	for (const line of result.stdout.split("\n")) {
		if (line.trim() === "") {
			continue;
		}

		hasChanges = true;
		if (line.startsWith("??")) {
			hasUnstaged = true;
			continue;
		}

		const indexStatus = line[0] || " ";
		const worktreeStatus = line[1] || " ";
		if (indexStatus !== " ") {
			hasStaged = true;
		}
		if (worktreeStatus !== " ") {
			hasUnstaged = true;
		}
	}

	return {
		hasChanges,
		hasStaged,
		hasUnstaged,
	};
}

function hasStagedChanges(cwd: string): boolean {
	const result = runCommand("git", ["diff", "--cached", "--quiet", "--ignore-submodules", "--"], cwd);
	return result.status === 1;
}

async function prepareStagedChanges(ctx: any, cwd: string): Promise<boolean> {
	const status = getGitStatus(cwd);
	if (!status.hasChanges) {
		ctx.ui.notify("No changes to commit.", "info");
		return false;
	}

	if (status.hasUnstaged && status.hasStaged) {
		const choice = await ctx.ui.select("Changes to commit", [
			"Stage all changes",
			"Use staged changes only",
			"Cancel",
		]);
		if (!choice || choice === "Cancel") {
			return false;
		}
		if (choice === "Stage all changes") {
			const staged = runCommand("git", ["add", "-A"], cwd);
			if (staged.status !== 0) {
				ctx.ui.notify(`git add failed: ${staged.stderr.trim() || staged.error || "unknown error"}`, "error");
				return false;
			}
		}
	} else if (status.hasUnstaged && !status.hasStaged) {
		const choice = await ctx.ui.select("No staged changes yet", ["Stage all changes", "Cancel"]);
		if (choice !== "Stage all changes") {
			return false;
		}

		const staged = runCommand("git", ["add", "-A"], cwd);
		if (staged.status !== 0) {
			ctx.ui.notify(`git add failed: ${staged.stderr.trim() || staged.error || "unknown error"}`, "error");
			return false;
		}
	}

	if (!hasStagedChanges(cwd)) {
		ctx.ui.notify("No staged changes to commit.", "info");
		return false;
	}

	return true;
}

function getReadOnlyTools(pi: ExtensionAPI): string[] {
	const active = pi.getActiveTools();
	const allowed = new Set(["read", "bash", "grep", "find", "ls"]);
	const filtered = active.filter((tool) => allowed.has(tool));
	return filtered.length > 0 ? filtered : active;
}

async function generateWithCurrentSession(pi: ExtensionAPI, ctx: any, prompt: string, progressMessage: string): Promise<string | undefined> {
	const beforeCount = ctx.sessionManager.getBranch().length;
	const previousTools = pi.getActiveTools();
	const nextTools = getReadOnlyTools(pi);

	if (JSON.stringify(previousTools) !== JSON.stringify(nextTools)) {
		pi.setActiveTools(nextTools);
	}

	ctx.ui.notify(progressMessage, "info");

	try {
		pi.sendMessage(
			{
				customType: "git-ai-hidden-prompt",
				content: prompt,
				display: false,
			},
			{ triggerTurn: true },
		);
		await ctx.waitForIdle();
	} finally {
		if (JSON.stringify(previousTools) !== JSON.stringify(nextTools)) {
			pi.setActiveTools(previousTools);
		}
	}

	const branch = ctx.sessionManager.getBranch();
	const recentEntries = branch.slice(beforeCount);
	const { text, incomplete } = getLastAssistantText(recentEntries);
	if (incomplete) {
		ctx.ui.notify(`Generation did not complete (${incomplete}).`, "warning");
		return undefined;
	}
	if (!text) {
		ctx.ui.notify("No draft was generated.", "warning");
		return undefined;
	}

	return text;
}

function stripArgumentTokens(args: string | undefined, tokens: string[]): string {
	const raw = (args || "").trim();
	if (raw === "") {
		return "";
	}

	const pattern = new RegExp(`(^|\\s)(?:${tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?=\\s|$)`, "gi");
	return raw.replace(pattern, " ").replace(/\s+/g, " ").trim();
}

function buildCommitPrompt(cwd: string, extraContext?: string): string {
	const branch = getCurrentBranch(cwd);
	return [
		"Generate a git commit message for the currently staged changes.",
		"",
		"This is a non-interactive automation task. Behave like a formatter, not a conversation.",
		"Use the existing session context plus the actual staged git diff.",
		"Inspect the repo in read-only mode only.",
		"Do not edit files. Do not run git commit. Do not ask questions. Do not explain your reasoning. Do not add any prose before or after the required output.",
		"",
		"Please inspect the staged changes using commands like:",
		"- git diff --cached --stat",
		"- git diff --cached --name-status",
		"- git diff --cached --unified=1",
		"- git diff --cached -- <path>",
		"- read files if needed for context",
		"",
		`Current branch: ${branch}`,
		extraContext?.trim() ? "" : undefined,
		extraContext?.trim() ? "Additional user context:" : undefined,
		extraContext?.trim() ? extraContext.trim() : undefined,
		"",
		"Return exactly this format and nothing else:",
		"SUBJECT: <single-line conventional commit subject>",
		"BODY:",
		"- <bullet summarizing the main staged change>",
		"- <bullet summarizing an important implementation detail or rationale>",
		"- <optional bullet for testing or follow-up, only if justified>",
		"",
		"Constraints:",
		"- Use a conventional commit subject with a required scope",
		"- Allowed types: feat, fix, refactor, chore, docs, test, build, ci, perf, style",
		"- Keep the subject concise and specific",
		"- Body must be plain text bullets suitable for a git commit body",
		"- Only describe the staged changes, not the whole branch",
		"- Do not invent testing or behavior that did not happen",
	].filter((line): line is string => typeof line === "string").join("\n");
}

function parseCommitDraft(text: string): CommitDraft | undefined {
	const normalized = text.trim();
	const explicit = normalized.match(/(?:^|\n)SUBJECT:\s*(.+?)\nBODY:\s*([\s\S]*)$/i);
	if (explicit) {
		const subject = explicit[1]?.trim() || "";
		const body = explicit[2]?.trim() || "";
		if (subject && body) {
			return { subject, body };
		}
	}
	return undefined;
}

function fallbackCommitDraft(cwd: string): CommitDraft {
	const files = runCommand("git", ["diff", "--cached", "--name-only"], cwd).stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const first = files[0] || "repo";
	const scope = first.split("/")[0]?.replace(/[^a-zA-Z0-9._-]/g, "-").toLowerCase() || "repo";
	const shortstat = runCommand("git", ["diff", "--cached", "--shortstat"], cwd).stdout.trim();
	return {
		subject: `chore(${scope}): update staged changes`,
		body: [
			shortstat ? `- ${shortstat}` : "- Update the currently staged changes.",
			files.length > 0 ? `- Touch ${files.slice(0, 3).join(", ")}${files.length > 3 ? ", ..." : ""}` : "- Refine the current implementation.",
		].join("\n"),
	};
}

function buildCommitMessageText(draft: CommitDraft): string {
	return `${draft.subject}\n\n${draft.body.trim()}\n`;
}

function buildPrPrompt(cwd: string, extraContext?: string): string {
	const branch = getCurrentBranch(cwd);
	return [
		"Generate a pull request title and body for the current committed branch.",
		"",
		"This is a non-interactive automation task. Behave like a formatter, not a conversation.",
		"Use the existing session context plus the committed branch diff.",
		"Inspect the repo in read-only mode only.",
		"Do not edit files. Do not run av pr. Do not ask questions. Do not explain your reasoning. Do not add any prose before or after the required output.",
		"",
		"Please inspect the branch using commands like:",
		"- av diff",
		"- git log --oneline --decorate -n 20",
		"- git diff --stat ...",
		"- read files if needed for context",
		"",
		`Current branch: ${branch}`,
		extraContext?.trim() ? "" : undefined,
		extraContext?.trim() ? "Additional user context:" : undefined,
		extraContext?.trim() ? extraContext.trim() : undefined,
		"",
		"Return exactly this format and nothing else:",
		"TITLE: <single-line PR title>",
		"BODY:",
		"## Summary",
		"- <what changed>",
		"- <important implementation detail or rationale>",
		"",
		"## Testing",
		"- <tests run, or 'Not run' if none were run>",
		"",
		"## Notes",
		"- <optional reviewer guidance if useful>",
		"",
		"Constraints:",
		"- Title must use strict conventional commit format with a required scope",
		"- Allowed title types: feat, fix, refactor, chore, docs, test, build, ci, perf, style",
		"- Title should be concise and specific",
		"- Body should be markdown suitable for GitHub PR descriptions",
		"- Use only information supported by the session and repo inspection",
		"- Do not invent tests, benchmarks, or rollout plans",
	].filter((line): line is string => typeof line === "string").join("\n");
}

function buildPrFormatRepairPrompt(rawDraft: string): string {
	return [
		"Reformat the following PR draft into the exact required structure.",
		"Do not add commentary or explanations.",
		"Preserve the substance of the draft.",
		"If the draft already contains markdown sections like Summary or Testing, keep them in BODY.",
		"Return exactly this format and nothing else:",
		"TITLE: <single-line PR title>",
		"BODY:",
		"<markdown body>",
		"",
		"Draft to reformat:",
		"```",
		rawDraft.trim(),
		"```",
	].join("\n");
}

function stripOptionalCodeFence(text: string): string {
	const normalized = text.trim();
	const fenced = normalized.match(/^```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)\n```$/);
	return fenced?.[1]?.trim() || normalized;
}

function parsePrDraft(text: string): PrDraft | undefined {
	const normalized = stripOptionalCodeFence(text);
	const explicit = normalized.match(/(?:^|\n)TITLE:\s*(.+?)\nBODY:\s*([\s\S]*)$/i);
	if (explicit) {
		const title = explicit[1]?.trim() || "";
		const body = explicit[2]?.trim() || "";
		if (title && body) {
			return { title, body };
		}
	}

	const titleWithImplicitBody = normalized.match(/(?:^|\n)(?:PR\s+)?TITLE:\s*(.+?)(?:\n|$)([\s\S]*)$/i);
	if (titleWithImplicitBody) {
		const title = titleWithImplicitBody[1]?.trim() || "";
		const body = titleWithImplicitBody[2]?.replace(/^BODY:\s*/i, "")?.trim() || "";
		if (title && body) {
			return { title, body };
		}
	}

	const lines = normalized.split(/\r?\n/);
	const firstNonEmptyIndex = lines.findIndex((line) => line.trim() !== "");
	if (firstNonEmptyIndex >= 0) {
		const title = lines[firstNonEmptyIndex]?.trim() || "";
		const body = lines.slice(firstNonEmptyIndex + 1).join("\n").trim();
		const conventional = /^(feat|fix|refactor|chore|docs|test|build|ci|perf|style)\([A-Za-z0-9._/-]+\): .+$/;
		if (conventional.test(title) && body !== "") {
			return { title, body };
		}
	}

	return undefined;
}

function fallbackPrDraft(cwd: string): PrDraft {
	const branch = getCurrentBranch(cwd);
	const latestSubject = runCommand("git", ["log", "-1", "--pretty=%s"], cwd).stdout.trim();
	const files = runCommand("git", ["diff", "--name-only", "HEAD~1", "HEAD"], cwd).stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const shortstat = runCommand("git", ["diff", "--shortstat", "HEAD~1", "HEAD"], cwd).stdout.trim();
	const first = files[0] || branch || "repo";
	const scope = first.split("/")[0]?.replace(/[^a-zA-Z0-9._-]/g, "-").toLowerCase() || "repo";
	const conventional = /^(feat|fix|refactor|chore|docs|test|build|ci|perf|style)\([A-Za-z0-9._/-]+\): .+$/;
	const title = conventional.test(latestSubject) ? latestSubject : `chore(${scope}): update branch changes`;
	return {
		title,
		body: [
			"## Summary",
			shortstat ? `- ${shortstat}` : `- Update branch ${branch}.`,
			files.length > 0 ? `- Touch ${files.slice(0, 5).join(", ")}${files.length > 5 ? ", ..." : ""}.` : "- Refine the current branch implementation.",
			"",
			"## Testing",
			"- Not run",
		].join("\n"),
	};
}

function hasExistingPr(cwd: string): boolean {
	const branch = getCurrentBranch(cwd);

	if (hasCommand("gh", cwd)) {
		const gh = runCommand("gh", ["pr", "view", branch, "--json", "number"], cwd);
		return gh.status === 0;
	}

	const av = runCommand("av", ["pr", "status"], cwd);
	return av.status === 0;
}

function getExistingPrDetails(cwd: string): ExistingPrDetails | undefined {
	if (!hasCommand("gh", cwd)) {
		return undefined;
	}

	const branch = getCurrentBranch(cwd);
	const result = runCommand("gh", ["pr", "view", branch, "--json", "title,body"], cwd);
	if (result.status !== 0 || result.stdout.trim() === "") {
		return undefined;
	}

	try {
		const parsed = JSON.parse(result.stdout) as { title?: unknown; body?: unknown };
		return {
			title: typeof parsed.title === "string" ? parsed.title : "",
			body: typeof parsed.body === "string" ? parsed.body : "",
		};
	} catch {
		return undefined;
	}
}

function parseReviewTargets(args: string | undefined): ReviewTarget[] | undefined {
	const normalized = (args || "").trim().toLowerCase();
	if (normalized === "" || normalized === "all" || normalized === "both") {
		return ["coderabbit", "codex"];
	}

	const tokens = normalized.split(/\s+/).filter(Boolean);
	const targets = new Set<ReviewTarget>();
	for (const token of tokens) {
		if (token === "coderabbit" || token === "cr" || token === "rabbit") {
			targets.add("coderabbit");
			continue;
		}
		if (token === "codex" || token === "cx") {
			targets.add("codex");
			continue;
		}
		return undefined;
	}

	return targets.size > 0 ? Array.from(targets) : ["coderabbit", "codex"];
}

function getReviewTriggerComment(target: ReviewTarget): string {
	return target === "coderabbit" ? "@coderabbit review" : "/codex review";
}

function getReviewTargetLabel(target: ReviewTarget): string {
	return target === "coderabbit" ? "Coderabbit" : "Codex";
}

function getReviewTargetForTriggerBody(body: string): ReviewTarget | undefined {
	return REVIEW_TRIGGER_TO_TARGET[body.trim().toLowerCase()];
}

function authorMatchesReviewTarget(target: ReviewTarget, author: string): boolean {
	return REVIEW_BOT_AUTHOR_MATCHERS[target].some((matcher) => matcher.test(author));
}

function bodyMatchesReviewTarget(target: ReviewTarget, body: string): boolean {
	return REVIEW_BOT_BODY_MATCHERS[target].some((matcher) => matcher.test(body));
}

function getTimestamp(value: string | undefined): number {
	if (!value) {
		return 0;
	}

	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : 0;
}

function getLatestTimestamp(...values: Array<string | undefined>): number {
	return Math.max(...values.map((value) => getTimestamp(value)), 0);
}

function shouldIgnoreBotReviewBody(body: string): boolean {
	return REVIEW_IGNORED_BODY_MATCHERS.some((matcher) => matcher.test(body));
}

function toReviewAnchor(comment: Record<string, unknown>): ReviewAnchor | undefined {
	const body = normalizeReviewBody(comment.body);
	const target = getReviewTargetForTriggerBody(body);
	const id = Number(comment.id || 0);
	if (!target || id <= 0) {
		return undefined;
	}

	return {
		target,
		id,
		author: normalizeReviewAuthor(comment.user),
		body,
		createdAt: typeof comment.created_at === "string" ? comment.created_at : "",
		updatedAt: typeof comment.updated_at === "string" ? comment.updated_at : "",
		url: typeof comment.html_url === "string" ? comment.html_url : undefined,
	};
}

function getLatestReviewRoundAnchors(issueComments: Array<Record<string, unknown>>): ReviewAnchor[] {
	const anchors = issueComments
		.map((comment) => toReviewAnchor(comment))
		.filter((anchor): anchor is ReviewAnchor => !!anchor)
		.sort((a, b) => getTimestamp(a.createdAt) - getTimestamp(b.createdAt));
	if (anchors.length === 0) {
		return [];
	}

	const latest = anchors[anchors.length - 1];
	const latestTime = getTimestamp(latest.createdAt);
	const roundCandidates: ReviewAnchor[] = [];
	for (let i = anchors.length - 1; i >= 0; i -= 1) {
		const anchor = anchors[i];
		if (latestTime - getTimestamp(anchor.createdAt) > REVIEW_ROUND_MAX_GAP_MS) {
			break;
		}
		roundCandidates.push(anchor);
	}

	const byTarget = new Map<ReviewTarget, ReviewAnchor>();
	for (const anchor of roundCandidates) {
		if (!byTarget.has(anchor.target)) {
			byTarget.set(anchor.target, anchor);
		}
	}

	return Array.from(byTarget.values()).sort((a, b) => getTimestamp(a.createdAt) - getTimestamp(b.createdAt));
}

function getLatestAnchorsForTargets(issueComments: Array<Record<string, unknown>>, targets: ReviewTarget[]): { anchors: ReviewAnchor[]; missingTargets: ReviewTarget[] } {
	const available = issueComments
		.map((comment) => toReviewAnchor(comment))
		.filter((anchor): anchor is ReviewAnchor => !!anchor)
		.sort((a, b) => getTimestamp(b.createdAt) - getTimestamp(a.createdAt));
	const anchors: ReviewAnchor[] = [];
	const missingTargets: ReviewTarget[] = [];
	for (const target of targets) {
		const anchor = available.find((item) => item.target === target);
		if (anchor) {
			anchors.push(anchor);
		} else {
			missingTargets.push(target);
		}
	}

	return {
		anchors: anchors.sort((a, b) => getTimestamp(a.createdAt) - getTimestamp(b.createdAt)),
		missingTargets,
	};
}

function buildReviewAnchorKey(anchors: ReviewAnchor[]): string {
	return anchors
		.slice()
		.sort((a, b) => a.target.localeCompare(b.target) || a.id - b.id)
		.map((anchor) => `${anchor.target}-${anchor.id}`)
		.join("-") || "no-anchor";
}

function formatReviewAnchorSummary(anchors: ReviewAnchor[]): string {
	return anchors
		.map((anchor) => `${getReviewTargetLabel(anchor.target)}#${anchor.id}`)
		.join(", ");
}

function getReviewTargetForItem(author: string, body: string, targets: ReviewTarget[]): ReviewTarget | undefined {
	const bodyMatch = targets.find((target) => bodyMatchesReviewTarget(target, body));
	if (bodyMatch) {
		return bodyMatch;
	}

	return targets.find((target) => authorMatchesReviewTarget(target, author));
}

function textMatchesPrFeedbackBot(author: string, body: string): boolean {
	const value = `${author}\n${body}`;
	return PR_FEEDBACK_BOT_MATCHERS.some((matcher) => matcher.test(value));
}

function parsePrNumber(value: string | undefined): number | undefined {
	const trimmed = (value || "").trim();
	if (!trimmed) {
		return undefined;
	}
	const match = trimmed.match(/^#?(\d+)$/) || trimmed.match(/\/pull\/(\d+)\/?$/i);
	if (!match) {
		return undefined;
	}
	const parsed = Number(match[1]);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parsePrFeedbackOptions(args: string | undefined): PrFeedbackOptions {
	const tokens = (args || "").trim().split(/\s+/).filter(Boolean);
	let apply = false;
	const prTokens: string[] = [];
	for (const token of tokens) {
		const normalized = token.toLowerCase();
		if (normalized === "--apply" || normalized === "apply") {
			apply = true;
			continue;
		}
		prTokens.push(token);
	}

	const prArg = prTokens.join(" ").trim();
	const prNumber = parsePrNumber(prArg);
	return {
		apply,
		prNumber,
		valid: prTokens.length === 0 || !!prNumber,
	};
}

function getPrFeedbackCommentTimestamp(comment: PrFeedbackComment): number {
	return getLatestTimestamp(comment.updatedAt, comment.createdAt);
}

function filterLatestPrFeedbackBatchByAuthor(comments: PrFeedbackComment[]): PrFeedbackComment[] {
	const latestByAuthor = new Map<string, number>();
	for (const comment of comments) {
		const timestamp = getPrFeedbackCommentTimestamp(comment);
		latestByAuthor.set(comment.author, Math.max(latestByAuthor.get(comment.author) || 0, timestamp));
	}

	return comments.filter((comment) => {
		const latest = latestByAuthor.get(comment.author) || 0;
		const timestamp = getPrFeedbackCommentTimestamp(comment);
		return latest === 0 || timestamp === 0 || latest - timestamp <= PR_FEEDBACK_BATCH_MAX_GAP_MS;
	});
}

function fetchOpenPrFeedbackComments(cwd: string, prNumber?: number): PrFeedbackResult | undefined {
	const metadata = getPrMetadata(cwd, prNumber);
	if (!metadata) {
		return undefined;
	}

	const [owner, name] = metadata.repo.split("/");
	if (!owner || !name) {
		return undefined;
	}

	const query = `
		query PrFeedback($owner: String!, $name: String!, $number: Int!) {
			repository(owner: $owner, name: $name) {
				pullRequest(number: $number) {
					number
					url
					reviewThreads(first: 100) {
						nodes {
							isResolved
							path
							line
							comments(first: 50) {
								nodes {
									id
									body
									url
									createdAt
									updatedAt
									author {
										login
									}
								}
							}
						}
					}
				}
			}
		}
	`;
	const result = runCommand(
		"gh",
		["api", "graphql", "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${metadata.number}`, "-f", `query=${query}`],
		cwd,
	);
	if (result.status !== 0 || !result.stdout.trim()) {
		return undefined;
	}

	const parsed = parseJsonObject<{
		data?: {
			repository?: {
				pullRequest?: {
					url?: unknown;
					reviewThreads?: {
						nodes?: Array<{
							isResolved?: unknown;
							path?: unknown;
							line?: unknown;
							comments?: {
								nodes?: Array<{
									id?: unknown;
									body?: unknown;
									url?: unknown;
									createdAt?: unknown;
									updatedAt?: unknown;
									author?: { login?: unknown } | null;
								}>;
							};
						}>;
					};
				};
			};
		};
	}>(result.stdout);
	const pullRequest = parsed?.data?.repository?.pullRequest;
	if (!pullRequest) {
		return undefined;
	}

	const comments: PrFeedbackComment[] = [];
	const reviewsResult = runCommand("gh", ["api", `repos/${metadata.repo}/pulls/${metadata.number}/reviews?per_page=100`], cwd);
	if (reviewsResult.status === 0) {
		for (const review of parseJsonObject<Array<Record<string, unknown>>>(reviewsResult.stdout) || []) {
			const body = normalizeReviewBody(review.body);
			const author = normalizeReviewAuthor(review.user);
			const state = typeof review.state === "string" ? review.state.toUpperCase() : "";
			if (!body || state !== "CHANGES_REQUESTED" || !textMatchesPrFeedbackBot(author, body)) {
				continue;
			}
			comments.push({
				id: `review:${Number(review.id || comments.length + 1)}`,
				author,
				body,
				createdAt: typeof review.submitted_at === "string" ? review.submitted_at : "",
				updatedAt: typeof review.submitted_at === "string" ? review.submitted_at : "",
				url: typeof review.html_url === "string" ? review.html_url : undefined,
			});
		}
	}

	for (const thread of pullRequest.reviewThreads?.nodes || []) {
		if (thread.isResolved === true) {
			continue;
		}
		for (const comment of thread.comments?.nodes || []) {
			const body = normalizeReviewBody(comment.body);
			const author = typeof comment.author?.login === "string" ? comment.author.login : "unknown";
			if (!body || !textMatchesPrFeedbackBot(author, body)) {
				continue;
			}
			comments.push({
				id: typeof comment.id === "string" ? comment.id : `${author}:${comments.length + 1}`,
				author,
				body,
				createdAt: typeof comment.createdAt === "string" ? comment.createdAt : "",
				updatedAt: typeof comment.updatedAt === "string" ? comment.updatedAt : typeof comment.createdAt === "string" ? comment.createdAt : "",
				url: typeof comment.url === "string" ? comment.url : undefined,
				path: typeof thread.path === "string" ? thread.path : undefined,
				line: typeof thread.line === "number" ? thread.line : undefined,
			});
		}
	}

	const latestBatchComments = filterLatestPrFeedbackBatchByAuthor(comments)
		.sort((a, b) => getPrFeedbackCommentTimestamp(a) - getPrFeedbackCommentTimestamp(b));

	return {
		metadata: {
			...metadata,
			url: typeof pullRequest.url === "string" ? pullRequest.url : metadata.url,
		},
		comments: latestBatchComments,
	};
}

function formatPrFeedbackPrompt(result: PrFeedbackResult, options: { includeAnnotations?: boolean } = {}): string {
	const lines: Array<string | undefined> = [
		"Determine if these changes are still valid and make the required updates.",
		"Only act on feedback that is still relevant to the current code. Ignore comments that are obsolete, already addressed, or contradicted by the current implementation.",
		"After making updates, summarize concisely what changed, why the changes were needed, and which feedback was skipped as no longer valid.",
		"",
		"<pr_feedback>",
		result.metadata.url ? `PR: ${result.metadata.url}` : `PR #${result.metadata.number}`,
		`Fetched latest unresolved/open feedback batch per GitHub bot author from CodeRabbit, Code Review by GPT-5 Codex, and Copilot: ${result.comments.length}`,
	];

	for (const comment of result.comments) {
		const location = comment.path ? `${comment.path}${typeof comment.line === "number" ? `:${comment.line}` : ""}` : "general";
		lines.push("", `## ${location}`, options.includeAnnotations ? "Annotation: KEEP or SKIP" : undefined, comment.url ? `URL: ${comment.url}` : undefined, "", comment.body);
	}

	lines.push("</pr_feedback>");
	return lines.filter((line): line is string => typeof line === "string").join("\n");
}

function formatPrFeedbackDifInput(result: PrFeedbackResult): string {
	return [
		"Annotate the PR feedback you want to work on.",
		"Add KEEP next to feedback the LLM should address and SKIP next to feedback that should be ignored.",
		"When you save/exit dif, the annotations are copied to the clipboard.",
		"",
		"---",
		"",
		formatPrFeedbackPrompt(result, { includeAnnotations: true }),
	].join("\n");
}

async function openPrFeedbackInDif(ctx: any, cwd: string, result: PrFeedbackResult): Promise<boolean> {
	const safeRepo = result.metadata.repo.replace(/[^A-Za-z0-9_.-]+/g, "-");
	const feedbackDir = path.join(REVIEW_SNAPSHOTS_ROOT, safeRepo);
	const feedbackPath = path.join(feedbackDir, `pr-${result.metadata.number}-feedback.md`);
	const input = formatPrFeedbackDifInput(result);
	await mkdir(feedbackDir, { recursive: true });
	await writeFile(feedbackPath, `${input.trimEnd()}\n`, "utf8");
	ctx.ui.notify(`Saved PR feedback markdown to ${feedbackPath}`, "info");
	return launchDif(
		ctx,
		["--stdin", "--stdin-name", feedbackPath],
		input,
		{ DIF_CLIPBOARD_MODE: "pr-feedback" },
		cwd,
	);
}

function fetchPrDiscussionData(cwd: string): PrDiscussionData | undefined {
	const metadata = getPrMetadata(cwd);
	if (!metadata) {
		return undefined;
	}

	const issueCommentsResult = runCommand("gh", ["api", `repos/${metadata.repo}/issues/${metadata.number}/comments?per_page=100`], cwd);
	const reviewCommentsResult = runCommand("gh", ["api", `repos/${metadata.repo}/pulls/${metadata.number}/comments?per_page=100`], cwd);
	const reviewsResult = runCommand("gh", ["api", `repos/${metadata.repo}/pulls/${metadata.number}/reviews?per_page=100`], cwd);
	if (issueCommentsResult.status !== 0 || reviewCommentsResult.status !== 0 || reviewsResult.status !== 0) {
		return undefined;
	}

	return {
		metadata,
		issueComments: parseJsonObject<Array<Record<string, unknown>>>(issueCommentsResult.stdout) || [],
		reviewComments: parseJsonObject<Array<Record<string, unknown>>>(reviewCommentsResult.stdout) || [],
		reviews: parseJsonObject<Array<Record<string, unknown>>>(reviewsResult.stdout) || [],
	};
}

function getPrUrl(cwd: string, commandOutput?: string): string | undefined {
	if (hasCommand("gh", cwd)) {
		const branch = getCurrentBranch(cwd);
		const result = runCommand("gh", ["pr", "view", branch, "--json", "url"], cwd);
		if (result.status === 0 && result.stdout.trim() !== "") {
			try {
				const parsed = JSON.parse(result.stdout) as { url?: unknown };
				if (typeof parsed.url === "string" && parsed.url.trim() !== "") {
					return parsed.url.trim();
				}
			} catch {
				// Fall through to output parsing.
			}
		}
	}

	const output = commandOutput?.trim() || "";
	if (output !== "") {
		const match = output.match(/https?:\/\/github\.com\/[^\s)]+\/pull\/\d+/i);
		if (match?.[0]) {
			return match[0];
		}
	}

	return undefined;
}

function formatPrMessage(message: string, prUrl?: string): string {
	return prUrl ? `${message} PR: ${prUrl}` : message;
}

async function fetchAndStoreBotReviewSnapshot(cwd: string, targets?: ReviewTarget[]): Promise<{ snapshot: ReviewSnapshot; previous?: ReviewSnapshot; delta: ReviewSnapshotDelta; missingTargets: ReviewTarget[]; paths: ReviewSnapshotPaths } | undefined> {
	const discussion = fetchPrDiscussionData(cwd);
	if (!discussion) {
		return undefined;
	}

	const resolution = targets
		? getLatestAnchorsForTargets(discussion.issueComments, targets)
		: { anchors: getLatestReviewRoundAnchors(discussion.issueComments), missingTargets: [] as ReviewTarget[] };
	if (resolution.anchors.length === 0) {
		return undefined;
	}

	const anchorKey = buildReviewAnchorKey(resolution.anchors);
	const anchorTimes = new Map(resolution.anchors.map((anchor) => [anchor.target, getTimestamp(anchor.createdAt)]));
	const selectedTargets = resolution.anchors.map((anchor) => anchor.target);
	const includeBotItem = (author: string, createdAt: string, updatedAt: string | undefined, body: string): ReviewTarget | undefined => {
		if (!body || REVIEW_TRIGGER_BODIES.has(body) || shouldIgnoreBotReviewBody(body)) {
			return undefined;
		}

		const target = getReviewTargetForItem(author, body, selectedTargets);
		if (!target) {
			return undefined;
		}

		return getLatestTimestamp(createdAt, updatedAt) >= (anchorTimes.get(target) || 0) ? target : undefined;
	};

	const items: ReviewSnapshotItem[] = [
		...discussion.issueComments
			.map((comment) => {
				const author = normalizeReviewAuthor(comment.user);
				const body = normalizeReviewBody(comment.body);
				const createdAt = typeof comment.created_at === "string" ? comment.created_at : "";
				const updatedAt = typeof comment.updated_at === "string" ? comment.updated_at : "";
				return includeBotItem(author, createdAt, updatedAt, body)
					? {
						key: `issue_comment:${Number(comment.id || 0)}`,
						kind: "issue_comment" as const,
						id: Number(comment.id || 0),
						author,
						body,
						createdAt,
						updatedAt,
						url: typeof comment.html_url === "string" ? comment.html_url : undefined,
					}
					: undefined;
			})
			.filter(Boolean) as ReviewSnapshotItem[],
		...discussion.reviewComments
			.map((comment) => {
				const author = normalizeReviewAuthor(comment.user);
				const body = normalizeReviewBody(comment.body);
				const createdAt = typeof comment.created_at === "string" ? comment.created_at : "";
				const updatedAt = typeof comment.updated_at === "string" ? comment.updated_at : "";
				return includeBotItem(author, createdAt, updatedAt, body)
					? {
						key: `review_comment:${Number(comment.id || 0)}`,
						kind: "review_comment" as const,
						id: Number(comment.id || 0),
						author,
						body,
						createdAt,
						updatedAt,
						url: typeof comment.html_url === "string" ? comment.html_url : undefined,
						path: typeof comment.path === "string" ? comment.path : undefined,
						line: typeof comment.line === "number" ? comment.line : undefined,
					}
					: undefined;
			})
			.filter(Boolean) as ReviewSnapshotItem[],
		...discussion.reviews
			.map((review) => {
				const author = normalizeReviewAuthor(review.user);
				const body = normalizeReviewBody(review.body);
				const createdAt = typeof review.submitted_at === "string" ? review.submitted_at : "";
				return includeBotItem(author, createdAt, createdAt, body)
					? {
						key: `review:${Number(review.id || 0)}`,
						kind: "review" as const,
						id: Number(review.id || 0),
						author,
						body,
						createdAt,
						updatedAt: createdAt,
						url: typeof review.html_url === "string" ? review.html_url : undefined,
						state: typeof review.state === "string" ? review.state : undefined,
					}
					: undefined;
			})
			.filter(Boolean) as ReviewSnapshotItem[],
	]
		.sort((a, b) => (a.updatedAt || a.createdAt).localeCompare(b.updatedAt || b.createdAt));

	const snapshot: ReviewSnapshot = {
		fetchedAt: new Date().toISOString(),
		repo: discussion.metadata.repo,
		prNumber: discussion.metadata.number,
		prUrl: discussion.metadata.url,
		scope: "bot_reviews",
		anchorKey,
		anchors: resolution.anchors,
		targets: selectedTargets,
		items,
	};
	const paths = getReviewSnapshotPaths(cwd, discussion.metadata.number, `bots-${anchorKey}`);
	const previous = await readReviewSnapshot(paths.latestPath);
	if (previous) {
		await writeReviewSnapshot(paths.previousPath, previous);
	}
	await writeReviewSnapshot(paths.latestPath, snapshot);

	return {
		snapshot,
		previous,
		delta: buildReviewSnapshotDelta(previous, snapshot),
		missingTargets: resolution.missingTargets,
		paths,
	};
}

function extractRawUrls(text: string): string[] {
	return Array.from(text.matchAll(/https?:\/\/[^\s<>()]+/gi), (match) => match[0].replace(/[),.;!?]+$/g, ""));
}

function isLikelyMediaUrl(url: string): boolean {
	const normalized = url.toLowerCase();
	return /(\.png|\.jpe?g|\.gif|\.webp|\.bmp|\.svg|\.mp4|\.mov|\.webm|\.m4v)(?:[?#].*)?$/.test(normalized)
		|| normalized.includes("github.com/user-attachments/assets/")
		|| normalized.includes("user-images.githubusercontent.com/")
		|| normalized.includes("loom.com/share/")
		|| normalized.includes("app.screencast.com/")
		|| normalized.includes("drive.google.com/file/");
}

function extractMediaUrls(text: string): string[] {
	return Array.from(new Set(extractRawUrls(text).filter(isLikelyMediaUrl)));
}

function hasMediaReferences(text: string): boolean {
	return extractMediaUrls(text).length > 0 || /!\[[^\]]*\]\(([^)]+)\)/.test(text);
}

function extractMediaSections(body: string): string[] {
	const normalized = body.trim();
	if (normalized === "") {
		return [];
	}

	const sections: string[] = [];
	let current: string[] = [];
	const pushCurrent = () => {
		const text = current.join("\n").trim();
		if (text !== "" && hasMediaReferences(text)) {
			sections.push(text);
		}
		current = [];
	};

	for (const line of normalized.split(/\r?\n/)) {
		if (/^#{1,6}\s+/.test(line) && current.length > 0) {
			pushCurrent();
		}
		current.push(line);
	}
	pushCurrent();

	return Array.from(new Set(sections));
}

function extractAvMetadataBlock(body: string | undefined): string | undefined {
	if (!body) {
		return undefined;
	}

	const match = body.match(/<!--\s*av pr metadata[\s\S]*?-->/i);
	return match?.[0]?.trim() || undefined;
}

function mergePreservedPrBody(existingBody: string | undefined, nextBody: string): { body: string; preservedSections: number; preservedMetadata: boolean } {
	if (!existingBody || existingBody.trim() === "") {
		return { body: nextBody, preservedSections: 0, preservedMetadata: false };
	}

	const preservedChunks: string[] = [];
	let preservedSections = 0;

	const nextUrls = new Set(extractMediaUrls(nextBody));
	const missingSections = extractMediaSections(existingBody).filter((section) => {
		if (nextBody.includes(section)) {
			return false;
		}

		const sectionUrls = extractMediaUrls(section);
		return sectionUrls.length === 0 || sectionUrls.some((url) => !nextUrls.has(url));
	});
	if (missingSections.length > 0) {
		preservedSections = missingSections.length;
		preservedChunks.push("<!-- Preserved media references from the previous PR description -->", "", missingSections.join("\n\n"));
	}

	const avMetadataBlock = extractAvMetadataBlock(existingBody);
	const preservedMetadata = !!avMetadataBlock && !nextBody.includes(avMetadataBlock);
	if (preservedMetadata && avMetadataBlock) {
		preservedChunks.push(avMetadataBlock);
	}

	if (preservedChunks.length === 0) {
		return { body: nextBody, preservedSections: 0, preservedMetadata: false };
	}

	return {
		body: `${nextBody.trimEnd()}\n\n${preservedChunks.join("\n\n")}\n`,
		preservedSections,
		preservedMetadata,
	};
}

async function maybeCommitBeforePr(pi: ExtensionAPI, ctx: any, cwd: string, args?: string): Promise<boolean> {
	const status = getGitStatus(cwd);
	if (!status.hasChanges) {
		return true;
	}

	const preferAmend = /(^|\s)(amend|--amend)(\s|$)/.test(args || "");
	const choices = preferAmend
		? ["Amend last commit, then update PR", "Update PR with committed changes only", "Cancel"]
		: ["Commit changes, then update PR", "Amend last commit, then update PR", "Update PR with committed changes only", "Cancel"];
	const choice = await ctx.ui.select("Pending changes detected", choices);
	if (!choice || choice === "Cancel") {
		return false;
	}
	if (choice === "Update PR with committed changes only") {
		ctx.ui.notify("Updating the PR from committed changes only. Pending local changes were left untouched.", "info");
		return true;
	}

	const amend = choice.startsWith("Amend");
	return runCommitFlow(pi, ctx, cwd, amend, stripArgumentTokens(args, ["amend", "--amend"]));
}

function writeTempFile(prefix: string, content: string): { dir: string; file: string } {
	const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
	const file = path.join(dir, "message.txt");
	writeFileSync(file, content, "utf8");
	return { dir, file };
}

function cleanupTempDir(dir: string): void {
	rmSync(dir, { force: true, recursive: true });
}

async function runCommitFlow(pi: ExtensionAPI, ctx: any, cwd: string, amend = false, extraContext?: string): Promise<boolean> {
	const ready = await prepareStagedChanges(ctx, cwd);
	if (!ready) {
		return false;
	}

	const generated = await generateWithCurrentSession(pi, ctx, buildCommitPrompt(cwd, extraContext), "Generating commit message with current session context...");
	let draft = generated ? parseCommitDraft(generated) : undefined;
	if (!draft) {
		draft = fallbackCommitDraft(cwd);
		ctx.ui.notify("Used a fallback commit message because the AI response was not in the expected format.", "warning");
	}

	const temp = writeTempFile("pi-commit-", buildCommitMessageText(draft));
	try {
		const result = runCommand("git", amend ? ["commit", "--amend", "-F", temp.file] : ["commit", "-F", temp.file], cwd);
		if (result.status !== 0) {
			ctx.ui.notify(`git commit failed: ${result.stderr.trim() || result.error || "unknown error"}`, "error");
			return false;
		}

		ctx.ui.notify(`${amend ? "Amended" : "Created"} commit: ${draft.subject}`, "success");
		return true;
	} finally {
		cleanupTempDir(temp.dir);
	}
}

async function generatePrDraft(pi: ExtensionAPI, ctx: any, cwd: string, extraContext?: string): Promise<GeneratedPrDraft> {
	const generated = await generateWithCurrentSession(pi, ctx, buildPrPrompt(cwd, extraContext), "Generating PR title and description...");
	let draft = generated ? parsePrDraft(generated) : undefined;
	if (draft) {
		return { draft, usedFallback: false };
	}

	if (generated) {
		ctx.ui.notify("Initial PR draft was not in the expected format. Retrying with a formatting pass...", "info");
		const repaired = await generateWithCurrentSession(pi, ctx, buildPrFormatRepairPrompt(generated), "Reformatting PR draft...");
		draft = repaired ? parsePrDraft(repaired) : undefined;
		if (draft) {
			return { draft, usedFallback: false };
		}
	}

	ctx.ui.notify("Used a fallback PR draft because the AI response was not in the expected format.", "warning");
	return { draft: fallbackPrDraft(cwd), usedFallback: true };
}

async function runPrFlow(pi: ExtensionAPI, ctx: any, cwd: string, extraContext?: string): Promise<boolean> {
	const { draft, usedFallback } = await generatePrDraft(pi, ctx, cwd, extraContext);

	if (hasExistingPr(cwd)) {
		if (hasCommand("gh", cwd)) {
			const pushResult = runCommand("av", ["pr"], cwd);
			if (pushResult.status !== 0) {
				ctx.ui.notify(`av pr failed: ${pushResult.stderr.trim() || pushResult.error || "unknown error"}`, "error");
				return false;
			}

			if (usedFallback) {
				const prUrl = getPrUrl(cwd, `${pushResult.stdout}\n${pushResult.stderr}`);
				ctx.ui.notify(
					formatPrMessage("Published updates to the current PR. Skipped PR description refresh because draft generation fell back to a minimal template.", prUrl),
					"warning",
				);
				return true;
			}

			const existing = getExistingPrDetails(cwd);
			const merged = mergePreservedPrBody(existing?.body, draft.body);
			const editResult = runCommand("gh", ["pr", "edit", "--title", draft.title, "--body-file", "-"], cwd, merged.body);
			if (editResult.status !== 0) {
				ctx.ui.notify(`gh pr edit failed: ${editResult.stderr.trim() || editResult.error || "unknown error"}`, "error");
				return false;
			}

			const prUrl = getPrUrl(cwd, `${pushResult.stdout}\n${pushResult.stderr}\n${editResult.stdout}\n${editResult.stderr}`);
			ctx.ui.notify(
				formatPrMessage(
					merged.preservedSections > 0 || merged.preservedMetadata
						? "Published updates to the current PR and refreshed the description while preserving Aviator metadata and existing rich content."
						: "Published updates to the current PR and refreshed the description.",
					prUrl,
				),
				"success",
			);
			return true;
		}

		if (usedFallback) {
			const result = runCommand("av", ["pr"], cwd);
			if (result.status !== 0) {
				ctx.ui.notify(`av pr failed: ${result.stderr.trim() || result.error || "unknown error"}`, "error");
				return false;
			}

			const prUrl = getPrUrl(cwd, `${result.stdout}\n${result.stderr}`);
			ctx.ui.notify(formatPrMessage("Published updates to the current PR. Skipped PR description refresh because draft generation fell back to a minimal template.", prUrl), "warning");
			return true;
		}

		const result = runCommand("av", ["pr", "--edit", "--title", draft.title, "--body", "-"], cwd, draft.body);
		if (result.status !== 0) {
			ctx.ui.notify(`av pr failed: ${result.stderr.trim() || result.error || "unknown error"}`, "error");
			return false;
		}

		const prUrl = getPrUrl(cwd, `${result.stdout}\n${result.stderr}`);
		ctx.ui.notify(formatPrMessage("Published updates to the current PR and refreshed the description.", prUrl), "success");
		return true;
	}

	const result = runCommand("av", ["pr", "--title", draft.title, "--body", "-"], cwd, draft.body);
	if (result.status !== 0) {
		ctx.ui.notify(`av pr failed: ${result.stderr.trim() || result.error || "unknown error"}`, "error");
		return false;
	}

	if (!usedFallback && hasCommand("gh", cwd)) {
		const existing = getExistingPrDetails(cwd);
		const merged = mergePreservedPrBody(existing?.body, draft.body);
		const editResult = runCommand("gh", ["pr", "edit", "--title", draft.title, "--body-file", "-"], cwd, merged.body);
		if (editResult.status !== 0) {
			ctx.ui.notify(`gh pr edit failed after PR creation: ${editResult.stderr.trim() || editResult.error || "unknown error"}`, "error");
			return false;
		}

		const prUrl = getPrUrl(cwd, `${result.stdout}\n${result.stderr}\n${editResult.stdout}\n${editResult.stderr}`);
		ctx.ui.notify(
			formatPrMessage(
				merged.preservedSections > 0 || merged.preservedMetadata
					? "Created a new PR and refreshed the initial description while preserving Aviator metadata and existing rich content."
					: "Created a new PR and refreshed the initial description.",
				prUrl,
			),
			"success",
		);
		return true;
	}

	const prUrl = getPrUrl(cwd, `${result.stdout}\n${result.stderr}`);
	ctx.ui.notify(formatPrMessage(usedFallback ? "Created a new PR with a fallback description." : "Created a new PR.", prUrl), usedFallback ? "warning" : "success");
	return true;
}

async function triggerPrReviews(ctx: any, cwd: string, targets: ReviewTarget[]): Promise<boolean> {
	if (!hasCommand("gh", cwd)) {
		ctx.ui.notify("/pr review requires GitHub CLI (`gh`) to post PR comments.", "warning");
		return false;
	}

	if (!hasExistingPr(cwd)) {
		ctx.ui.notify("/pr review requires an existing PR for the current branch.", "warning");
		return false;
	}

	for (const target of targets) {
		const comment = getReviewTriggerComment(target);
		const result = runCommand("gh", ["pr", "comment", getCurrentBranch(cwd), "--body", comment], cwd);
		if (result.status !== 0) {
			ctx.ui.notify(`gh pr comment failed for ${target}: ${result.stderr.trim() || result.error || "unknown error"}`, "error");
			return false;
		}
	}

	const prUrl = getPrUrl(cwd);
	const label = targets.length === 2 ? "Coderabbit and Codex" : getReviewTargetLabel(targets[0]);
	ctx.ui.notify(formatPrMessage(`Triggered ${label} review on the current PR.`, prUrl), "success");
	return true;
}

async function runWithLoader<T>(ctx: any, title: string, work: () => Promise<T>, fallback: T): Promise<T> {
	return await ctx.ui.custom<T>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, title);
		let completed = false;
		loader.onAbort = () => {
			if (!completed) {
				done(fallback);
			}
		};

		setTimeout(() => {
			work()
				.then((result) => {
					completed = true;
					done(result);
				})
				.catch(() => {
					completed = true;
					done(fallback);
				});
		}, 0);

		return loader;
	});
}

async function runPrReviewFlow(ctx: any, cwd: string, targets: ReviewTarget[]): Promise<boolean> {
	const label = targets.length === 2 ? "Coderabbit and Codex" : getReviewTargetLabel(targets[0]);
	return runWithLoader(ctx, `Triggering ${label} review...`, () => triggerPrReviews(ctx, cwd, targets), false);
}

async function openReviewSnapshotInDif(ctx: any, cwd: string, latest: ReviewSnapshot, previous: ReviewSnapshot | undefined, paths: ReviewSnapshotPaths, emptyMessage: string, noDeltaMessage: string): Promise<boolean> {
	const delta = buildReviewSnapshotDelta(previous, latest);
	const hasDelta = delta.added.length > 0 || delta.changed.length > 0;
	const markdown = hasDelta ? formatReviewDeltaMarkdown(latest, delta) : formatCurrentReviewMarkdown(latest);
	if (!hasDelta && latest.items.length === 0) {
		ctx.ui.notify(emptyMessage, "info");
		return false;
	}
	if (!hasDelta) {
		ctx.ui.notify(noDeltaMessage, "info");
	}

	await writeReviewDeltaFile(paths.deltaPath, markdown);
	return launchDif(
		ctx,
		["--stdin", "--stdin-name", paths.deltaPath],
		formatReviewDiffInput(markdown),
		{ DIF_CLIPBOARD_MODE: "review-delta" },
		cwd,
	);
}

async function runPrFeedbackFlow(pi: ExtensionAPI, ctx: any, cwd: string, args?: string): Promise<boolean> {
	if (!hasCommand("gh", cwd)) {
		ctx.ui.notify("/pr feedback requires GitHub CLI (`gh`).", "warning");
		return false;
	}

	const options = parsePrFeedbackOptions(args);
	if (!options.valid) {
		ctx.ui.notify("Usage: /pr feedback [--apply] [pr-number]", "info");
		return false;
	}
	const prNumber = options.prNumber;
	if (!prNumber && !hasExistingPr(cwd)) {
		ctx.ui.notify("/pr feedback requires an existing PR for the current branch, or pass a PR number.", "warning");
		return false;
	}

	const fetched = await runWithLoader(
		ctx,
		prNumber ? `Fetching unresolved bot feedback for PR #${prNumber}...` : "Fetching unresolved bot feedback for the current PR...",
		async () => ({ ok: true as const, result: fetchOpenPrFeedbackComments(cwd, prNumber) }),
		{ ok: false as const },
	);
	if (!fetched.ok || !fetched.result) {
		ctx.ui.notify("Could not fetch unresolved PR feedback from GitHub.", "error");
		return false;
	}
	if (fetched.result.comments.length === 0) {
		ctx.ui.notify("No unresolved CodeRabbit, GPT-5 Codex, or Copilot review comments/requested-change reviews found.", "info");
		return false;
	}

	const authors = summarizeReviewAuthors(fetched.result.comments.map((comment) => ({
		key: comment.id,
		kind: "review_comment" as const,
		id: 0,
		author: comment.author,
		body: comment.body,
		createdAt: comment.createdAt,
		updatedAt: comment.updatedAt,
		url: comment.url,
		path: comment.path,
		line: comment.line,
	})));
	if (options.apply) {
		pi.sendUserMessage(formatPrFeedbackPrompt(fetched.result));
		ctx.ui.notify(
			formatPrMessage(`Sent ${fetched.result.comments.length} latest feedback items by bot author${authors ? ` (${authors})` : ""} to the LLM.`, fetched.result.metadata.url),
			"success",
		);
		return true;
	}

	ctx.ui.notify(
		formatPrMessage(`Fetched ${fetched.result.comments.length} latest feedback items by bot author${authors ? ` (${authors})` : ""}. Opening dif for KEEP/SKIP annotations.`, fetched.result.metadata.url),
		"success",
	);
	return openPrFeedbackInDif(ctx, cwd, fetched.result);
}

async function runPrCommentsFlow(ctx: any, cwd: string, targets?: ReviewTarget[]): Promise<boolean> {
	if (!hasCommand("gh", cwd)) {
		ctx.ui.notify("/pr comments requires GitHub CLI (`gh`).", "warning");
		return false;
	}

	if (!hasExistingPr(cwd)) {
		ctx.ui.notify("/pr comments requires an existing PR for the current branch.", "warning");
		return false;
	}

	const targetLabel = !targets || targets.length === 0
		? "latest bot review comments"
		: targets.length === 2
			? "bot review comments"
			: `${getReviewTargetLabel(targets[0])} review comments`;
	const fetched = await runWithLoader(
		ctx,
		`Fetching ${targetLabel}...`,
		() => fetchAndStoreBotReviewSnapshot(cwd, targets),
		undefined,
	);
	if (!fetched) {
		const usage = targets?.length
			? `No review trigger comments found for ${targets.map((target) => getReviewTargetLabel(target)).join(" and ")}. Run /pr review first.`
			: "No recent review trigger comments found. Run /pr review first.";
		ctx.ui.notify(usage, "info");
		return false;
	}

	const authors = summarizeReviewAuthors(fetched.snapshot.items);
	const anchorSummary = fetched.snapshot.anchors && fetched.snapshot.anchors.length > 0
		? formatReviewAnchorSummary(fetched.snapshot.anchors)
		: "the latest review round";
	const missingTargets = fetched.missingTargets.length > 0
		? ` Missing anchors: ${fetched.missingTargets.map((target) => getReviewTargetLabel(target)).join(", ")}.`
		: "";
	const summary = formatPrMessage(
		`Fetched ${fetched.snapshot.items.length} bot review entries (${fetched.delta.added.length} new, ${fetched.delta.changed.length} updated) from ${anchorSummary}.${missingTargets}`,
		fetched.snapshot.prUrl,
	);
	ctx.ui.notify(authors ? `${summary} Authors: ${authors}` : summary, fetched.snapshot.items.length > 0 ? "success" : "info");

	return openReviewSnapshotInDif(
		ctx,
		cwd,
		fetched.snapshot,
		fetched.previous,
		fetched.paths,
		"No bot review comments were found after the latest review trigger comments.",
		"No new bot review delta was found, so showing the current bot review comments instead.",
	);
}

type PrCommandAction = "submit" | "review" | "comments" | "feedback" | "url";

type PrPushOptions = {
	cleanedArgs?: string;
	reviewTargets?: ReviewTarget[];
	reviewRequested: boolean;
	valid: boolean;
};

function parsePrCommandArgs(args: string | undefined): { action: PrCommandAction; rest?: string } {
	const raw = (args || "").trim();
	if (raw === "") {
		return { action: "submit", rest: undefined };
	}

	const [first, ...rest] = raw.split(/\s+/);
	const normalized = first.toLowerCase();
	if (
		normalized === "submit"
		|| normalized === "push"
		|| normalized === "review"
		|| normalized === "comments"
		|| normalized === "comment"
		|| normalized === "feedback"
		|| normalized === "url"
	) {
		return {
			action: normalized === "comment" ? "comments" : normalized === "push" ? "submit" : normalized,
			rest: rest.join(" ").trim() || undefined,
		};
	}

	return { action: "submit", rest: raw };
}

function parsePrPushOptions(args: string | undefined): PrPushOptions {
	const raw = (args || "").trim();
	if (raw === "") {
		return { cleanedArgs: undefined, reviewRequested: false, valid: true };
	}

	const tokens = raw.split(/\s+/).filter(Boolean);
	const reviewIndex = tokens.findIndex((token) => token.toLowerCase() === "review" || token.toLowerCase() === "--review");
	if (reviewIndex < 0) {
		return { cleanedArgs: raw, reviewRequested: false, valid: true };
	}

	const reviewTokens = tokens.slice(reviewIndex + 1);
	const reviewTargets = reviewTokens.length === 0 ? ["coderabbit", "codex"] : parseReviewTargets(reviewTokens.join(" "));
	if (!reviewTargets) {
		return { cleanedArgs: raw, reviewRequested: true, valid: false };
	}

	const cleanedTokens = tokens.slice(0, reviewIndex);
	return {
		cleanedArgs: cleanedTokens.join(" ").trim() || undefined,
		reviewTargets,
		reviewRequested: true,
		valid: true,
	};
}

async function runPrRegenFlow(pi: ExtensionAPI, ctx: any, cwd: string, extraContext?: string): Promise<boolean> {
	const { draft, usedFallback } = await generatePrDraft(pi, ctx, cwd, extraContext);

	if (hasExistingPr(cwd)) {
		if (!hasCommand("gh", cwd)) {
			ctx.ui.notify("/pr-regen needs GitHub CLI (`gh`) to edit an existing PR non-interactively.", "warning");
			return false;
		}
		if (usedFallback) {
			const prUrl = getPrUrl(cwd);
			ctx.ui.notify(formatPrMessage("Skipped PR regeneration because draft generation fell back to a minimal template.", prUrl), "warning");
			return false;
		}

		const existing = getExistingPrDetails(cwd);
		const merged = mergePreservedPrBody(existing?.body, draft.body);
		const result = runCommand("gh", ["pr", "edit", "--title", draft.title, "--body-file", "-"], cwd, merged.body);
		if (result.status !== 0) {
			ctx.ui.notify(`gh pr edit failed: ${result.stderr.trim() || result.error || "unknown error"}`, "error");
			return false;
		}

		const prUrl = getPrUrl(cwd, `${result.stdout}\n${result.stderr}`);
		ctx.ui.notify(
			formatPrMessage(
				merged.preservedSections > 0 || merged.preservedMetadata
					? "Regenerated the current PR title and description and preserved Aviator metadata and existing rich content."
					: "Regenerated the current PR title and description.",
				prUrl,
			),
			"success",
		);
		return true;
	}

	const result = runCommand("av", ["pr", "--title", draft.title, "--body", "-"], cwd, draft.body);
	if (result.status !== 0) {
		ctx.ui.notify(`av pr failed: ${result.stderr.trim() || result.error || "unknown error"}`, "error");
		return false;
	}

	const prUrl = getPrUrl(cwd, `${result.stdout}\n${result.stderr}`);
	ctx.ui.notify(formatPrMessage(usedFallback ? "Created a new PR with a fallback title and description." : "Created a new PR with a generated title and description.", prUrl), usedFallback ? "warning" : "success");
	return true;
}

export default function gitAiExtension(pi: ExtensionAPI): void {
	pi.registerCommand("commit", {
		description: "Generate a commit message from current session context plus staged changes, then run git commit",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/commit requires the interactive TUI", "warning");
				return;
			}

			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current turn to finish before launching /commit", "warning");
				return;
			}

			const cwd = ctx.cwd || process.cwd();
			if (!isInsideGitRepo(cwd)) {
				ctx.ui.notify("/commit requires a git repository", "warning");
				return;
			}

			const amend = /(^|\s)(amend|--amend)(\s|$)/.test(args || "");
			const extraContext = stripArgumentTokens(args, ["amend", "--amend"]);
			await runCommitFlow(pi, ctx, cwd, amend, extraContext);
		},
	});

	pi.registerCommand("pr", {
		description: "Manage the current PR: /pr submit, /pr review, /pr comments, /pr feedback, or /pr url (/pr comment also works; /pr submit review auto-triggers reviews)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/pr requires the interactive TUI", "warning");
				return;
			}

			const cwd = ctx.cwd || process.cwd();
			if (!isInsideGitRepo(cwd)) {
				ctx.ui.notify("/pr requires a git repository", "warning");
				return;
			}

			const command = parsePrCommandArgs(args);
			if (command.action === "url") {
				const prUrl = getPrUrl(cwd);
				if (!prUrl) {
					ctx.ui.notify("No PR found for the current branch", "warning");
					return;
				}
				ctx.ui.notify(`Current PR: ${prUrl}`, "info");
				return;
			}

			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current turn to finish before launching /pr", "warning");
				return;
			}

			if (command.action === "submit") {
				if (!hasCommand("av", cwd)) {
					ctx.ui.notify("/pr submit requires the Aviator CLI (`av`).", "warning");
					return;
				}

				const pushOptions = parsePrPushOptions(command.rest);
				if (!pushOptions.valid) {
					ctx.ui.notify("Usage: /pr submit [amend|--amend] [extra context] [review|--review [all|coderabbit|codex]]", "info");
					return;
				}

				const ready = await maybeCommitBeforePr(pi, ctx, cwd, pushOptions.cleanedArgs);
				if (!ready) {
					return;
				}

				const extraContext = stripArgumentTokens(pushOptions.cleanedArgs, ["amend", "--amend"]);
				const pushed = await runPrFlow(pi, ctx, cwd, extraContext);
				if (pushed && pushOptions.reviewTargets) {
					await runPrReviewFlow(ctx, cwd, pushOptions.reviewTargets);
				}
				return;
			}

			if (command.action === "review") {
				const targets = parseReviewTargets(command.rest);
				if (!targets) {
					ctx.ui.notify("Usage: /pr review [all|coderabbit|codex]", "info");
					return;
				}

				await runPrReviewFlow(ctx, cwd, targets);
				return;
			}

			if (command.action === "feedback") {
				await runPrFeedbackFlow(pi, ctx, cwd, command.rest);
				return;
			}

			const requestedTargets = !command.rest ? undefined : parseReviewTargets(command.rest);
			if (command.rest && !requestedTargets) {
				ctx.ui.notify("Usage: /pr comments [coderabbit|codex|all] (alias: /pr comment)", "info");
				return;
			}

			await runPrCommentsFlow(ctx, cwd, requestedTargets);
		},
	});


	pi.registerCommand("pr-regen", {
		description: "Regenerate the PR title and description from the current session context and branch diff",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/pr-regen requires the interactive TUI", "warning");
				return;
			}

			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current turn to finish before launching /pr-regen", "warning");
				return;
			}

			const cwd = ctx.cwd || process.cwd();
			if (!isInsideGitRepo(cwd)) {
				ctx.ui.notify("/pr-regen requires a git repository", "warning");
				return;
			}

			if (!hasCommand("av", cwd)) {
				ctx.ui.notify("/pr-regen requires the Aviator CLI (`av`).", "warning");
				return;
			}

			if (getGitStatus(cwd).hasChanges) {
				ctx.ui.notify("/pr-regen only uses committed changes. Run /commit first.", "warning");
				return;
			}

			await runPrRegenFlow(pi, ctx, cwd, args?.trim() || undefined);
		},
	});
}
