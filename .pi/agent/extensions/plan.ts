import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

type CustomEntry = {
	type: "custom";
	customType?: string;
	data?: unknown;
};

type PlanModeState = {
	enabled: boolean;
	hasHistory: boolean;
};

type PlanLocation = {
	scopeRoot: string;
	scopeDir: string;
	sessionKey: string;
	planPath: string;
	sessionFile?: string;
};

type PlanSnapshotData = {
	label?: string;
	body?: string;
	updatedAt?: string;
	scopeRoot?: string;
	sessionKey?: string;
	sessionFile?: string;
	deleted?: boolean;
};

type ResolvedPlanSnapshot = {
	label: string;
	body: string;
	updatedAt: string;
	deleted: boolean;
	text: string;
};

type SavedPlan = {
	displayLabel: string;
	planPath: string;
	mtimeMs: number;
};

type PlanGitCommit = {
	hash: string;
	shortHash: string;
	subject: string;
	date: string;
};

const PLANS_ROOT = path.join(os.homedir(), ".local", "state", "pi", "plans");
const PLAN_MODE_ENTRY_TYPE = "plan-mode-state";
const PLAN_SNAPSHOT_ENTRY_TYPE = "plan-snapshot";
const MAX_PLAN_CONTEXT_CHARS = 6000;
const DEFAULT_PLAN_BODY = [
	"# Plan",
	"",
	"## Goal",
	"- Describe the objective for this session.",
	"",
	"## Steps",
	"- Add the next concrete tasks here.",
].join("\n");

function isSessionMessageEntry(entry: unknown): entry is SessionMessageEntry {
	return !!entry && typeof entry === "object" && (entry as { type?: string }).type === "message";
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
	return !!message && typeof message === "object" && (message as { role?: string }).role === "assistant";
}

function isCustomEntry(entry: unknown): entry is CustomEntry {
	return !!entry && typeof entry === "object" && (entry as { type?: string }).type === "custom";
}

function isPlanSnapshotData(data: unknown): data is PlanSnapshotData {
	return !!data && typeof data === "object";
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

function getLastCompletedAssistantText(branch: unknown[]): string | undefined {
	for (let i = branch.length - 1; i >= 0; i -= 1) {
		const entry = branch[i];
		if (!isSessionMessageEntry(entry) || !isAssistantMessage(entry.message)) {
			continue;
		}

		if (entry.message.stopReason && entry.message.stopReason !== "stop") {
			continue;
		}

		const text = extractTextParts(entry.message.content).join("\n").trim();
		if (text) {
			return text;
		}
	}

	return undefined;
}

function slugify(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "scope";
}

function getScopeRoot(cwd: string): string {
	const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	const root = result.status === 0 ? result.stdout.trim() : cwd;

	try {
		return realpathSync(root);
	} catch {
		return root;
	}
}

function getSessionKey(ctx: any): string {
	const sessionFile = ctx.sessionManager.getSessionFile?.();
	if (typeof sessionFile === "string" && sessionFile.trim() !== "") {
		return path.basename(sessionFile, path.extname(sessionFile));
	}

	const leafId = ctx.sessionManager.getLeafId?.();
	if (typeof leafId === "string" && leafId.trim() !== "") {
		return `ephemeral-${leafId}`;
	}

	return "ephemeral-current";
}

function getPlanLocation(ctx: any): PlanLocation {
	const cwd = ctx.sessionManager.getCwd?.() || ctx.cwd || process.cwd();
	const scopeRoot = getScopeRoot(cwd);
	const scopeBase = path.basename(scopeRoot);
	const scopeHash = createHash("sha1").update(scopeRoot).digest("hex").slice(0, 10);
	const scopeDir = path.join(PLANS_ROOT, `${slugify(scopeBase)}-${scopeHash}`);
	const sessionKey = getSessionKey(ctx);
	const sessionFile = ctx.sessionManager.getSessionFile?.() as string | undefined;

	return {
		scopeRoot,
		scopeDir,
		sessionKey,
		planPath: path.join(scopeDir, `${sessionKey}.md`),
		sessionFile,
	};
}

function getDefaultLabel(pi: ExtensionAPI, ctx: any): string {
	const sessionName = pi.getSessionName()?.trim();
	return sessionName || getSessionKey(ctx);
}

function extractSnapshotLabel(text: string, fallback: string): string {
	const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	for (const line of lines) {
		if (/^#{1,6}\s+/.test(line)) {
			return line.replace(/^#{1,6}\s+/, "").trim();
		}
		if (!line.startsWith("```")) {
			return line.slice(0, 80);
		}
	}
	return fallback;
}

function parseSnapshotLabel(text: string, fallback: string): string {
	const match = text.match(/^Label:\s*(.+)$/m);
	return match?.[1]?.trim() || fallback;
}

function parseSnapshotBody(text: string): string {
	const marker = "\n---\n\n";
	const index = text.indexOf(marker);
	return index >= 0 ? text.slice(index + marker.length).trim() : text.trim();
}

function normalizePlanBody(text: string): string {
	const trimmed = text.trim();
	return trimmed === "" ? DEFAULT_PLAN_BODY : trimmed;
}

function extractPlanDocument(text: string): string {
	const trimmed = text.trim();
	if (trimmed === "") {
		return DEFAULT_PLAN_BODY;
	}

	const fenced = trimmed.match(/```(?:markdown|md)?\n([\s\S]*?)```/i);
	if (fenced?.[1]) {
		return normalizePlanBody(fenced[1]);
	}

	const lines = trimmed.split(/\r?\n/);
	const headingIndex = lines.findIndex((line) => /^#{1,6}\s+/.test(line.trim()));
	if (headingIndex >= 0) {
		return normalizePlanBody(lines.slice(headingIndex).join("\n"));
	}

	return normalizePlanBody(trimmed);
}

function countMarkdownHeadings(text: string): number {
	return text
		.split(/\r?\n/)
		.filter((line) => /^#{1,6}\s+/.test(line.trim()))
		.length;
}

function normalizeAssistantPlanText(text: string): string {
	const trimmed = text.trim();
	if (trimmed.startsWith("# Plan Snapshot")) {
		return extractPlanDocument(parseSnapshotBody(trimmed));
	}
	return extractPlanDocument(trimmed);
}

function isSuspiciousPlanShrink(previous: ResolvedPlanSnapshot | undefined, nextText: string): boolean {
	if (!previous) {
		return false;
	}

	const previousBody = normalizePlanBody(previous.body);
	const nextBody = normalizeAssistantPlanText(nextText);
	const previousLength = previousBody.length;
	const nextLength = nextBody.length;
	if (previousLength < 300) {
		return false;
	}

	const previousHeadings = countMarkdownHeadings(previousBody);
	const nextHeadings = countMarkdownHeadings(nextBody);
	const gotMuchShorter = nextLength < previousLength * 0.6;
	const lostStructure = nextHeadings + 1 < previousHeadings;
	return gotMuchShorter && lostStructure;
}

function buildPlanSnapshotText(location: PlanLocation, snapshot: ResolvedPlanSnapshot): string {
	return [
		"# Plan Snapshot",
		`Label: ${snapshot.label}`,
		`Updated: ${snapshot.updatedAt}`,
		`Session: ${location.sessionKey}`,
		`SessionFile: ${location.sessionFile ?? "ephemeral"}`,
		`ScopeRoot: ${location.scopeRoot}`,
		"",
		"---",
		"",
		snapshot.body,
	].join("\n");
}

function resolvePlanSnapshot(pi: ExtensionAPI, ctx: any, location: PlanLocation, data?: PlanSnapshotData): ResolvedPlanSnapshot {
	const deleted = data?.deleted === true;
	const body = deleted ? "" : normalizePlanBody(data?.body || "");
	const label = (data?.label || "").trim() || extractSnapshotLabel(body, getDefaultLabel(pi, ctx));
	const updatedAt = data?.updatedAt || new Date().toISOString();
	const text = deleted ? "" : buildPlanSnapshotText(location, { label, body, updatedAt, deleted, text: "" });

	return {
		label,
		body,
		updatedAt,
		deleted,
		text,
	};
}

function buildPlanSnapshotData(pi: ExtensionAPI, ctx: any, location: PlanLocation, bodyText: string, label?: string): PlanSnapshotData {
	const body = normalizePlanBody(bodyText);
	return {
		label: (label || "").trim() || extractSnapshotLabel(body, getDefaultLabel(pi, ctx)),
		body,
		updatedAt: new Date().toISOString(),
		scopeRoot: location.scopeRoot,
		sessionKey: location.sessionKey,
		sessionFile: location.sessionFile,
		deleted: false,
	};
}

async function readSnapshot(planPath: string): Promise<string> {
	return readFile(planPath, "utf8").catch(() => "");
}

async function writeSnapshot(planPath: string, content: string): Promise<void> {
	await mkdir(path.dirname(planPath), { recursive: true });
	await writeFile(planPath, `${content.trimEnd()}\n`, "utf8");
}

async function deleteSnapshot(planPath: string): Promise<void> {
	await rm(planPath, { force: true });
}

function getPlanModeState(ctx: any): PlanModeState {
	let enabled = false;
	let hasHistory = false;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (!isCustomEntry(entry) || entry.customType !== PLAN_MODE_ENTRY_TYPE) {
			continue;
		}
		hasHistory = true;
		enabled = (entry.data as { enabled?: boolean } | undefined)?.enabled === true;
	}
	return { enabled, hasHistory };
}

function isPlanModeEnabled(ctx: any): boolean {
	return getPlanModeState(ctx).enabled;
}

function persistPlanMode(pi: ExtensionAPI, enabled: boolean): void {
	pi.appendEntry(PLAN_MODE_ENTRY_TYPE, { enabled });
}

function getLatestPlanSnapshotData(ctx: any): PlanSnapshotData | undefined {
	let latest: PlanSnapshotData | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (!isCustomEntry(entry) || entry.customType !== PLAN_SNAPSHOT_ENTRY_TYPE || !isPlanSnapshotData(entry.data)) {
			continue;
		}
		latest = entry.data;
	}
	return latest;
}

async function getCurrentPlanSnapshot(pi: ExtensionAPI, ctx: any): Promise<ResolvedPlanSnapshot | undefined> {
	const location = getPlanLocation(ctx);
	const sessionSnapshot = getLatestPlanSnapshotData(ctx);
	if (sessionSnapshot) {
		const resolved = resolvePlanSnapshot(pi, ctx, location, sessionSnapshot);
		return resolved.deleted ? undefined : resolved;
	}

	const fileSnapshot = await readSnapshot(location.planPath);
	if (fileSnapshot.trim() === "") {
		return undefined;
	}

	return resolvePlanSnapshot(pi, ctx, location, {
		label: parseSnapshotLabel(fileSnapshot, getDefaultLabel(pi, ctx)),
		body: parseSnapshotBody(fileSnapshot),
		updatedAt: new Date().toISOString(),
		deleted: false,
	});
}

async function syncPlanSnapshotFile(pi: ExtensionAPI, ctx: any): Promise<void> {
	const location = getPlanLocation(ctx);
	const sessionSnapshot = getLatestPlanSnapshotData(ctx);
	if (sessionSnapshot) {
		const resolved = resolvePlanSnapshot(pi, ctx, location, sessionSnapshot);
		if (resolved.deleted) {
			await deleteSnapshot(location.planPath);
			return;
		}

		const existing = await readSnapshot(location.planPath);
		if (existing.trimEnd() !== resolved.text.trimEnd()) {
			await writeSnapshot(location.planPath, resolved.text);
		}
		return;
	}

	const existing = await readSnapshot(location.planPath);
	if (existing.trim() === "") {
		await deleteSnapshot(location.planPath);
	}
}

async function ensurePlanGitRepo(location: PlanLocation): Promise<void> {
	await mkdir(location.scopeDir, { recursive: true });
	const gitDir = path.join(location.scopeDir, ".git");
	const hasGitDir = await stat(gitDir).then(() => true).catch(() => false);
	if (hasGitDir) {
		return;
	}

	spawnSync("git", ["init", "-q"], { cwd: location.scopeDir, stdio: "ignore" });
	spawnSync("git", ["config", "user.name", "pi plan snapshots"], { cwd: location.scopeDir, stdio: "ignore" });
	spawnSync("git", ["config", "user.email", "pi-plan@local"], { cwd: location.scopeDir, stdio: "ignore" });
}

function hasPlanGitChanges(location: PlanLocation): boolean {
	const diff = spawnSync("git", ["status", "--porcelain"], { cwd: location.scopeDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	return diff.status === 0 && diff.stdout.trim() !== "";
}

async function commitPlanGitSnapshot(location: PlanLocation, message: string): Promise<boolean> {
	await ensurePlanGitRepo(location);
	spawnSync("git", ["add", "-A"], { cwd: location.scopeDir, stdio: "ignore" });
	const diff = spawnSync("git", ["diff", "--cached", "--quiet", "--"], { cwd: location.scopeDir, stdio: "ignore" });
	if (diff.status === 0) {
		return false;
	}
	const commit = spawnSync("git", ["commit", "-q", "-m", message], { cwd: location.scopeDir, stdio: "ignore" });
	return commit.status === 0;
}

async function persistPlanSnapshot(pi: ExtensionAPI, ctx: any, bodyText: string, label?: string): Promise<void> {
	const location = getPlanLocation(ctx);
	await ensurePlanGitRepo(location);
	const cleanedBody = extractPlanDocument(bodyText);
	const data = buildPlanSnapshotData(pi, ctx, location, cleanedBody, label);
	const resolved = resolvePlanSnapshot(pi, ctx, location, data);
	pi.appendEntry(PLAN_SNAPSHOT_ENTRY_TYPE, data);
	await writeSnapshot(location.planPath, resolved.text);
}

async function clearPlanSnapshot(pi: ExtensionAPI, ctx: any): Promise<void> {
	const location = getPlanLocation(ctx);
	await ensurePlanGitRepo(location);
	pi.appendEntry(PLAN_SNAPSHOT_ENTRY_TYPE, {
		label: getDefaultLabel(pi, ctx),
		updatedAt: new Date().toISOString(),
		scopeRoot: location.scopeRoot,
		sessionKey: location.sessionKey,
		sessionFile: location.sessionFile,
		deleted: true,
	});
	await deleteSnapshot(location.planPath);
}

async function refreshPlanUi(pi: ExtensionAPI, ctx: any, enabled: boolean): Promise<void> {
	if (!ctx.hasUI) {
		return;
	}

	await syncPlanSnapshotFile(pi, ctx);
	const statusText = enabled ? "📝 plan on" : "📝 plan off";
	const statusColor = enabled ? "accent" : "muted";

	ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg(statusColor, statusText));
	ctx.ui.setWidget("plan-mode", undefined);
}

function formatPlanContext(location: PlanLocation, snapshot: string): string {
	const trimmed = snapshot.trim();
	const body = trimmed.length > MAX_PLAN_CONTEXT_CHARS
		? `${trimmed.slice(0, MAX_PLAN_CONTEXT_CHARS)}\n\n[Plan snapshot truncated for context]`
		: trimmed;

	return [
		"[PLAN MODE ACTIVE]",
		"Planning mode is ON for this session.",
		"This plan belongs to the current pi session. Keep maintaining the same session plan document unless the user asks otherwise.",
		"Treat the user's prompts as part of an ongoing planning session, but answer the user's actual question first.",
		"Many user messages in plan mode are conversational check-ins, clarifications, or tradeoff questions rather than requests to advance the plan.",
		"If the user is asking a question, discussing tradeoffs, or exploring options, answer normally without forcing a plan update.",
		"For prompts like 'does that make sense?', 'what do you think?', 'is that reasonable?', or similar, respond directly and conversationally instead of pushing the plan forward.",
		"Do not assume every message in plan mode means 'continue planning' or 'revise the plan'.",
		"Only update the saved plan when the user explicitly asks to change the plan, or when the conversation materially changes scope, sequencing, decisions, or implementation progress.",
		"Treat the plan like a document under version control: edit it in place instead of narrating changes around it.",
		"When you do update the plan, update the saved plan file directly with edit/write instead of printing the full plan in chat.",
		`Saved plan file: ${location.planPath}`,
		"After updating the plan file, reply with one short confirmation sentence only.",
		"Good examples: 'Plan updated.' or 'Updated the saved plan with the new steps.'",
		"Do not paste the full plan into the conversation unless the user explicitly asks to see it.",
		"When revising the plan, preserve existing sections and details unless the user explicitly asks to remove or replace them.",
		"Prefer editing the existing plan in place over rewriting it from scratch.",
		"Do not prefix the plan file with conversational text like 'I've updated the plan' or explanations.",
		"Incorporate both the user's intent and your own progress/understanding.",
		"Do not stop maintaining the plan until the user turns plan mode off.",
		`Plan git repo: ${path.join(location.scopeDir, '.git')}`,
		`Scope root: ${location.scopeRoot}`,
		`Session key: ${location.sessionKey}`,
		"",
		body ? `Latest saved plan snapshot:\n\n${body}` : "No saved plan snapshot yet. Start by producing an implementation plan in markdown.",
	].join("\n");
}

function isLikelyConversationalPlanTurn(prompt: string): boolean {
	const trimmed = prompt.trim();
	if (trimmed === "") {
		return false;
	}

	const normalized = trimmed.toLowerCase();
	if (normalized.includes("?")) {
		return true;
	}

	return [
		"does that make sense",
		"does this make sense",
		"what do you think",
		"does that seem right",
		"does this seem right",
		"is that reasonable",
		"is this reasonable",
		"sound good",
		"thoughts",
		"agree with this",
		"do you agree",
		"am i missing anything",
		"is there anything i'm missing",
		"sanity check",
		"gut check",
	].some((phrase) => normalized.includes(phrase));
}

function formatPlanConversationContext(location: PlanLocation, snapshot: string, userPrompt: string): string {
	return [
		"[PLAN MODE CONVERSATIONAL TURN]",
		"The user's latest message is a question, check-in, or clarification request.",
		"Answer the user directly and naturally.",
		"Acknowledge or verify their reasoning before proposing anything new.",
		"Do not continue planning by default.",
		"Do not update the saved plan file for this turn unless the user explicitly asks to revise the plan.",
		"Keep the response conversational rather than turning it into another planning artifact.",
		"",
		`Latest user message: ${userPrompt.trim()}`,
		"",
		formatPlanContext(location, snapshot),
	].join("\n");
}

function planUsage(): string {
	return [
		"/plan               Toggle plan mode for the current Pi session",
		"/plan on            Enable plan mode",
		"/plan off           Disable plan mode",
		"/plan show          Open the current session plan snapshot",
		"/plan copy          Copy the current session plan snapshot to the clipboard",
		"/plan review        Review the current plan snapshot with dif",
		"/plan diff          View unsaved git diff for the current plan",
		"/plan log           Browse saved plan commits and inspect older diffs",
		"/plan save          Commit current plan changes in the plan git repo",
		"/plan sync          Inspect current code changes and sync finished work into the plan",
		"/plan implement     Implement from the saved plan, sync progress, then leave plan mode off",
		"/plan clear         Delete the current session plan snapshot",
		"/plan label <text>  Set a friendly label for the current snapshot",
		"/plan path          Show the current snapshot path",
		"/plans              Browse saved plan snapshots for this worktree/directory",
	].join("\n");
}

function listPlanGitCommits(location: PlanLocation): PlanGitCommit[] {
	const fileName = `${location.sessionKey}.md`;
	const result = spawnSync("git", ["log", "--date=short", "--pretty=format:%H%x09%h%x09%ad%x09%s", "--", fileName], {
		cwd: location.scopeDir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (result.status !== 0 || result.stdout.trim() === "") {
		return [];
	}

	return result.stdout.split("\n").map((line) => {
		const [hash = "", shortHash = "", date = "", ...subjectParts] = line.split("\t");
		return {
			hash,
			shortHash,
			date,
			subject: subjectParts.join("\t").trim() || "(no subject)",
		} satisfies PlanGitCommit;
	}).filter((commit) => commit.hash !== "" && commit.shortHash !== "");
}

function getPlanCommitDiffArgs(location: PlanLocation, commitHash: string): string[] | undefined {
	const parents = spawnSync("git", ["rev-list", "--parents", "-n", "1", commitHash], {
		cwd: location.scopeDir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (parents.status !== 0 || parents.stdout.trim() === "") {
		return undefined;
	}

	const parts = parents.stdout.trim().split(/\s+/);
	const commit = parts[0];
	const parent = parts[1];
	const fileName = `${location.sessionKey}.md`;
	if (!commit) {
		return undefined;
	}

	if (parent) {
		return [parent, commit, "--only", fileName];
	}

	const emptyTree = spawnSync("git", ["hash-object", "-t", "tree", "/dev/null"], {
		cwd: location.scopeDir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (emptyTree.status !== 0 || emptyTree.stdout.trim() === "") {
		return undefined;
	}

	return [emptyTree.stdout.trim(), commit, "--only", fileName];
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

	ctx.ui.notify("Copied dif annotations to clipboard. Paste them back when ready.", "success");
	return true;
}

async function listSavedPlans(pi: ExtensionAPI, ctx: any): Promise<SavedPlan[]> {
	const location = getPlanLocation(ctx);
	const entries = await readdir(location.scopeDir, { withFileTypes: true }).catch(() => []);
	const plans = await Promise.all(
		entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
			.map(async (entry) => {
				const planPath = path.join(location.scopeDir, entry.name);
				const info = await stat(planPath);
				const text = await readSnapshot(planPath);
				const sessionKey = path.basename(entry.name, ".md");
				const label = parseSnapshotLabel(text, sessionKey);
				const isCurrent = sessionKey === location.sessionKey;
				return {
					displayLabel: isCurrent ? `${label} (${sessionKey}, current)` : `${label} (${sessionKey})`,
					planPath,
					mtimeMs: info.mtimeMs,
				} satisfies SavedPlan;
			}),
	);

	return plans.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export default function planExtension(pi: ExtensionAPI): void {
	let pendingPlanReviewFeedback = false;
	let persistNextAssistantAsPlan = false;
	let pendingPlanFileRevision: "review" | "sync" | "implement" | undefined;

	function formatPlanRevisionPrompt(location: PlanLocation, snapshot: ResolvedPlanSnapshot | undefined, feedback: string): string {
		const planText = snapshot?.text || "";
		return [
			"Revise the current session plan snapshot using the following review feedback.",
			"Always update the saved plan snapshot even if plan mode is currently off.",
			"Treat the plan like code: apply a minimal patch to the existing document rather than replacing it wholesale.",
			"Preserve all unrelated sections and details unless the feedback explicitly says to remove them.",
			"Prefer surgical edits to the existing plan over rewriting it from scratch.",
			"Do not include conversational text inside the plan file.",
			`Update this file directly with edit/write: ${location.planPath}`,
			`The plan file lives inside a git repo at: ${location.scopeDir}`,
			"After updating the file, respond with one short confirmation sentence only.",
			"Do not print the full revised plan in chat.",
			"",
			planText !== "" ? `Current plan snapshot:\n\n${planText}` : "No saved plan snapshot exists yet. Create the full plan from the feedback.",
			"",
			"Review feedback:",
			feedback,
		].join("\n");
	}

	function formatPlanSyncPrompt(location: PlanLocation, snapshot: ResolvedPlanSnapshot | undefined): string {
		const planText = snapshot?.text || "";
		return [
			"Sync the current session plan snapshot with the actual implementation status.",
			"Inspect the relevant code and recent code changes before deciding what to update.",
			"Use git status/diff and read the relevant files as needed to verify what is already finished, partially finished, or still remaining.",
			"Update the saved plan only if the implementation progress justifies it.",
			"Preserve unrelated sections and existing detail unless the current implementation clearly requires an update.",
			"Mark completed work clearly, adjust the remaining steps, and rewrite stale items only when necessary.",
			"Do not invent progress that you cannot verify from the code or git changes.",
			`Update this file directly with edit/write: ${location.planPath}`,
			`The plan file lives inside a git repo at: ${location.scopeDir}`,
			"If no saved plan snapshot exists yet, create one based on the current implementation and remaining work.",
			"After updating the file, respond with one short confirmation sentence only.",
			"Do not print the full plan in chat.",
			"",
			planText !== "" ? `Current plan snapshot:\n\n${planText}` : "No saved plan snapshot exists yet.",
		].join("\n");
	}

	function formatPlanImplementPrompt(extraContext?: string): string {
		return [
			"Continue implementing the current saved plan.",
			"Use the plan and the current repository state to choose the next meaningful work to complete.",
			"After making implementation progress, update the saved plan with whatever was finished or advanced if applicable.",
			extraContext ? "" : undefined,
			extraContext ? "Additional context:" : undefined,
			extraContext ? extraContext.trim() : undefined,
		].filter((line): line is string => typeof line === "string" && line !== "").join("\n");
	}

	function formatPlanImplementationContext(location: PlanLocation, snapshot: string, userPrompt: string): string {
		return [
			"[PLAN IMPLEMENT]",
			"This is an implementation turn for the current saved plan.",
			"Do actual implementation work using tools and code changes instead of only discussing the plan.",
			"Use the saved plan as the source of truth for what to do next, while also considering the user's latest message.",
			"Prioritize making concrete progress on the next unfinished or highest-value step.",
			"Do not spend the whole turn re-planning unless you are blocked or the code clearly requires a plan change first.",
			"Once you finish the implementation work for this turn, update the saved plan file directly to reflect completed items, partial progress, and remaining work if applicable.",
			"For this turn, do not follow the generic one-sentence plan-update confirmation rule. After implementing and updating the plan, reply normally with a concise summary of what you changed and what remains.",
			"",
			`Latest user message: ${userPrompt.trim()}`,
			"",
			formatPlanContext(location, snapshot),
		].join("\n");
	}

	pi.on("session_start", async (_event, ctx) => {
		pendingPlanReviewFeedback = false;
		persistNextAssistantAsPlan = false;
		pendingPlanFileRevision = undefined;
		await refreshPlanUi(pi, ctx, isPlanModeEnabled(ctx));
	});

	pi.on("session_tree", async (_event, ctx) => {
		pendingPlanReviewFeedback = false;
		persistNextAssistantAsPlan = false;
		pendingPlanFileRevision = undefined;
		await refreshPlanUi(pi, ctx, isPlanModeEnabled(ctx));
	});

	pi.on("input", async (event, ctx) => {
		if (!pendingPlanReviewFeedback) {
			return { action: "continue" };
		}

		const text = event.text.trim();
		if (text === "") {
			return { action: "continue" };
		}

		if (text.startsWith("/")) {
			pendingPlanReviewFeedback = false;
			return { action: "continue" };
		}

		const location = getPlanLocation(ctx);
		const snapshot = await getCurrentPlanSnapshot(pi, ctx);
		pendingPlanReviewFeedback = false;
		persistNextAssistantAsPlan = false;
		pendingPlanFileRevision = "review";
		ctx.ui.notify("Revising the current plan snapshot from your review feedback...", "info");
		return {
			action: "transform",
			text: formatPlanRevisionPrompt(location, snapshot, event.text),
		};
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const planMode = getPlanModeState(ctx);
		const location = getPlanLocation(ctx);
		const snapshot = await getCurrentPlanSnapshot(pi, ctx);

		if (pendingPlanFileRevision === "review" || persistNextAssistantAsPlan) {
			return {
				message: {
					customType: "plan-mode-context",
					content: [
						"[PLAN REVIEW REVISION]",
						"The user is providing review feedback for the current session plan snapshot.",
						"Revise the saved plan now, even if plan mode is currently off.",
						"Update the saved plan file directly instead of printing the full plan in chat.",
						"After updating it, respond with one short confirmation sentence only.",
						"",
						formatPlanContext(location, snapshot?.text || ""),
					].join("\n"),
					display: false,
				},
			};
		}

		if (pendingPlanFileRevision === "sync") {
			return {
				message: {
					customType: "plan-mode-context",
					content: [
						"[PLAN SYNC]",
						"Sync the saved plan snapshot with the actual implementation state and current code changes.",
						"Inspect the repository and relevant diffs before changing the plan.",
						"Only update the plan when you can verify progress from the code or git changes.",
						"Update the saved plan file directly instead of printing the full plan in chat.",
						"After updating it, respond with one short confirmation sentence only.",
						"",
						formatPlanContext(location, snapshot?.text || ""),
					].join("\n"),
					display: false,
				},
			};
		}

		if (pendingPlanFileRevision === "implement") {
			const promptText = typeof event.prompt === "string" ? event.prompt : "";
			return {
				message: {
					customType: "plan-mode-context",
					content: formatPlanImplementationContext(location, snapshot?.text || "", promptText),
					display: false,
				},
			};
		}

		if (planMode.enabled) {
			const promptText = typeof event.prompt === "string" ? event.prompt : "";
			const content = isLikelyConversationalPlanTurn(promptText)
				? formatPlanConversationContext(location, snapshot?.text || "", promptText)
				: formatPlanContext(location, snapshot?.text || "");
			return {
				message: {
					customType: "plan-mode-context",
					content,
					display: false,
				},
			};
		}

		if (planMode.hasHistory) {
			return {
				message: {
					customType: "plan-mode-context",
					content: [
						"[PLAN MODE INACTIVE]",
						"Planning mode is OFF for this session.",
						"Do not keep producing, revising, or maintaining the saved plan unless the user explicitly turns plan mode on again or explicitly asks to revise the saved plan.",
						"Do not treat ordinary implementation requests as planning requests.",
						"Do not print the saved plan or summarize it unless the user explicitly asks.",
						"Respond normally and focus only on the user's current request.",
					].join("\n"),
					display: false,
				},
			};
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		const enabled = isPlanModeEnabled(ctx);
		const shouldPersist = enabled || persistNextAssistantAsPlan || pendingPlanFileRevision !== undefined;
		if (!shouldPersist) {
			await refreshPlanUi(pi, ctx, false);
			return;
		}

		const previousSnapshot = await getCurrentPlanSnapshot(pi, ctx);
		const location = getPlanLocation(ctx);
		const fileText = await readSnapshot(location.planPath);

		if (pendingPlanFileRevision !== undefined || enabled) {
			if (fileText.trim() === "") {
				pendingPlanFileRevision = undefined;
				persistNextAssistantAsPlan = false;
				if (enabled) {
					ctx.ui.notify("Plan mode is on, but the saved plan file was not updated in this turn.", "info");
				}
				await refreshPlanUi(pi, ctx, enabled);
				return;
			}

			const revisedBody = parseSnapshotBody(fileText);
			if (isSuspiciousPlanShrink(previousSnapshot, revisedBody)) {
				pendingPlanFileRevision = undefined;
				persistNextAssistantAsPlan = false;
				ctx.ui.notify("Plan revision looked much shorter than the previous plan, so I kept the existing saved plan. Review the new draft manually if you still want it.", "warning");
				if (ctx.hasUI) {
					ctx.ui.setEditorText(fileText);
				}
				await syncPlanSnapshotFile(pi, ctx);
				await refreshPlanUi(pi, ctx, enabled);
				return;
			}

			const previousBody = previousSnapshot?.body?.trim() || "";
			if (revisedBody.trim() !== previousBody) {
				await persistPlanSnapshot(pi, ctx, revisedBody, parseSnapshotLabel(fileText, previousSnapshot?.label || getDefaultLabel(pi, ctx)));
				if (ctx.hasUI) {
					ctx.ui.notify("Plan updated. Use /plan review to inspect it.", "success");
				}
			}

			pendingPlanFileRevision = undefined;
			persistNextAssistantAsPlan = false;
			await refreshPlanUi(pi, ctx, enabled);
			return;
		}

		const latest = getLastCompletedAssistantText(ctx.sessionManager.getBranch());
		if (latest) {
			if (isSuspiciousPlanShrink(previousSnapshot, latest)) {
				persistNextAssistantAsPlan = false;
				ctx.ui.notify("Plan revision looked much shorter than the previous plan, so I kept the existing saved plan. Review the new draft manually if you still want it.", "warning");
				if (ctx.hasUI) {
					ctx.ui.setEditorText(latest);
				}
				await refreshPlanUi(pi, ctx, enabled);
				return;
			}

			await persistPlanSnapshot(pi, ctx, latest);
			if (ctx.hasUI) {
				ctx.ui.notify("Plan updated. Use /plan review to inspect it.", "success");
			}
		}

		persistNextAssistantAsPlan = false;
		await refreshPlanUi(pi, ctx, enabled);
	});

	pi.registerCommand("plan", {
		description: "Toggle planning mode for this session and manage the session plan snapshot",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/plan requires the interactive TUI", "warning");
				return;
			}

			const location = getPlanLocation(ctx);
			const rawArgs = (args || "").trim();
			const enabled = isPlanModeEnabled(ctx);

			if (rawArgs === "" || rawArgs === "toggle") {
				persistPlanMode(pi, !enabled);
				await refreshPlanUi(pi, ctx, !enabled);
				ctx.ui.notify(!enabled ? "Plan mode enabled for this session." : "Plan mode disabled for this session.", "success");
				return;
			}

			if (rawArgs === "help") {
				ctx.ui.notify(planUsage(), "info");
				return;
			}

			if (rawArgs === "on" || rawArgs === "start" || rawArgs === "enable") {
				persistPlanMode(pi, true);
				await refreshPlanUi(pi, ctx, true);
				ctx.ui.notify("Plan mode enabled for this session.", "success");
				return;
			}

			if (rawArgs === "off" || rawArgs === "stop" || rawArgs === "disable") {
				pendingPlanReviewFeedback = false;
				persistNextAssistantAsPlan = false;
				pendingPlanFileRevision = undefined;
				persistPlanMode(pi, false);
				await refreshPlanUi(pi, ctx, false);
				ctx.ui.notify("Plan mode disabled for this session.", "success");
				return;
			}

			if (rawArgs === "path") {
				ctx.ui.notify(location.planPath, "info");
				return;
			}

			if (rawArgs === "save") {
				await ensurePlanGitRepo(location);
				if (!hasPlanGitChanges(location)) {
					ctx.ui.notify("No plan changes to save.", "info");
					return;
				}

				const snapshot = await getCurrentPlanSnapshot(pi, ctx);
				const label = snapshot?.label || getDefaultLabel(pi, ctx);
				const ok = await commitPlanGitSnapshot(location, `Save ${label}`);
				if (!ok) {
					ctx.ui.notify("Failed to save plan changes to the plan git repo.", "warning");
					return;
				}

				ctx.ui.notify(`Saved plan changes in ${location.scopeDir}`, "success");
				return;
			}

			if (rawArgs === "show" || rawArgs === "open") {
				const snapshot = await getCurrentPlanSnapshot(pi, ctx);
				if (!snapshot) {
					ctx.ui.notify("No current session plan snapshot yet.", "info");
					return;
				}

				const edited = await ctx.ui.editor(`Plan Snapshot: ${path.basename(location.planPath)}`, snapshot.text);
				if (edited === undefined) {
					return;
				}

				if (edited.trim() === "") {
					await clearPlanSnapshot(pi, ctx);
					await refreshPlanUi(pi, ctx, enabled);
					ctx.ui.notify("Deleted current session plan snapshot.", "success");
					return;
				}

				const nextLabel = parseSnapshotLabel(edited, snapshot.label);
				const nextBody = parseSnapshotBody(edited);
				await persistPlanSnapshot(pi, ctx, nextBody, nextLabel);
				await refreshPlanUi(pi, ctx, enabled);
				ctx.ui.notify(`Saved snapshot: ${location.planPath}`, "success");
				return;
			}

			if (rawArgs === "copy") {
				const snapshot = await getCurrentPlanSnapshot(pi, ctx);
				if (!snapshot) {
					ctx.ui.notify("No current session plan snapshot yet.", "info");
					return;
				}

				const copied = spawnSync("pbcopy", {
					input: `${snapshot.text.trimEnd()}\n`,
					encoding: "utf8",
					stdio: ["pipe", "ignore", "ignore"],
				});
				if (copied.status !== 0) {
					ctx.ui.notify("Failed to copy plan to clipboard.", "warning");
					return;
				}

				ctx.ui.notify("Copied current plan snapshot to clipboard.", "success");
				return;
			}

			if (rawArgs === "clear") {
				const confirmed = await ctx.ui.confirm("Delete plan snapshot?", `Remove ${location.sessionKey}.md for this session?`);
				if (!confirmed) {
					return;
				}
				await clearPlanSnapshot(pi, ctx);
				await refreshPlanUi(pi, ctx, enabled);
				ctx.ui.notify("Deleted current session plan snapshot.", "success");
				return;
			}

			if (rawArgs === "sync") {
				if (!ctx.isIdle()) {
					ctx.ui.notify("Waiting for the current turn to finish before syncing the plan...", "info");
					await ctx.waitForIdle();
				}

				pendingPlanReviewFeedback = false;
				persistNextAssistantAsPlan = false;
				pendingPlanFileRevision = "sync";
				await syncPlanSnapshotFile(pi, ctx);
				const snapshot = await getCurrentPlanSnapshot(pi, ctx);
				const prompt = formatPlanSyncPrompt(location, snapshot);
				pi.sendUserMessage(prompt);
				ctx.ui.notify("Syncing the saved plan with the current implementation...", "info");
				return;
			}

			if (rawArgs === "implement" || rawArgs.startsWith("implement ")) {
				if (!ctx.isIdle()) {
					ctx.ui.notify("Waiting for the current turn to finish before continuing plan implementation...", "info");
					await ctx.waitForIdle();
				}

				const extraContext = rawArgs === "implement" ? "" : rawArgs.slice("implement".length).trim();
				pendingPlanReviewFeedback = false;
				persistNextAssistantAsPlan = false;
				pendingPlanFileRevision = "implement";
				persistPlanMode(pi, false);
				await syncPlanSnapshotFile(pi, ctx);
				await refreshPlanUi(pi, ctx, false);
				pi.sendUserMessage(formatPlanImplementPrompt(extraContext));
				ctx.ui.notify(extraContext ? "Continuing implementation with your extra context, syncing plan progress afterward, and leaving plan mode off..." : "Continuing implementation from the saved plan, syncing progress afterward, and leaving plan mode off...", "info");
				return;
			}

			if (rawArgs === "review") {
				if (!ctx.isIdle()) {
					ctx.ui.notify("Wait for the current turn to finish before launching /plan review", "warning");
					return;
				}

				const snapshot = await getCurrentPlanSnapshot(pi, ctx);
				if (!snapshot) {
					ctx.ui.notify("No current session plan snapshot to review.", "info");
					return;
				}

				const reviewed = await launchDif(
					ctx,
					["--stdin", "--stdin-name", "current-plan.md"],
					snapshot.text,
					{ DIF_CLIPBOARD_MODE: "plan-review" },
				);
				if (reviewed) {
					pendingPlanReviewFeedback = true;
					if (!enabled) {
						persistPlanMode(pi, true);
						await refreshPlanUi(pi, ctx, true);
					}
					ctx.ui.notify("Plan review enabled plan mode. Paste your feedback and I will revise the saved plan snapshot.", "info");
				}
				return;
			}

			if (rawArgs === "diff") {
				await ensurePlanGitRepo(location);
				if (!hasPlanGitChanges(location)) {
					ctx.ui.notify("No unsaved plan changes to diff.", "info");
					return;
				}

				await launchDif(ctx, ["--only", `${location.sessionKey}.md`], undefined, {}, location.scopeDir);
				return;
			}

			if (rawArgs === "log") {
				await ensurePlanGitRepo(location);
				const commits = listPlanGitCommits(location);
				if (commits.length === 0) {
					ctx.ui.notify("No saved plan commits yet.", "info");
					return;
				}

				const labels = commits.map((commit) => `${commit.shortHash} ${commit.date} ${commit.subject}`);
				const selection = await ctx.ui.select("Plan commit history", labels);
				if (!selection) {
					return;
				}

				const index = labels.indexOf(selection);
				const commit = index >= 0 ? commits[index] : undefined;
				if (!commit) {
					ctx.ui.notify("Couldn't resolve selected plan commit.", "warning");
					return;
				}

				const diffArgs = getPlanCommitDiffArgs(location, commit.hash);
				if (!diffArgs) {
					ctx.ui.notify("Couldn't build a diff for the selected plan commit.", "warning");
					return;
				}

				await launchDif(ctx, diffArgs, undefined, {}, location.scopeDir);
				return;
			}

			if (rawArgs.startsWith("label ")) {
				const label = rawArgs.slice("label ".length).trim();
				if (label === "") {
					ctx.ui.notify("Usage: /plan label <text>", "info");
					return;
				}

				const snapshot = await getCurrentPlanSnapshot(pi, ctx);
				await persistPlanSnapshot(pi, ctx, snapshot?.body || DEFAULT_PLAN_BODY, label);
				await refreshPlanUi(pi, ctx, enabled);
				ctx.ui.notify(`Plan label set to: ${label}`, "success");
				return;
			}

			ctx.ui.notify(planUsage(), "info");
		},
	});

	pi.registerCommand("plans", {
		description: "Browse saved plan snapshots for this worktree or directory",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/plans requires the interactive TUI", "warning");
				return;
			}

			await syncPlanSnapshotFile(pi, ctx);
			const plans = await listSavedPlans(pi, ctx);
			if (plans.length === 0) {
				ctx.ui.notify("No saved plan snapshots for this scope yet.", "info");
				return;
			}

			const selection = await ctx.ui.select("Saved plan snapshots", plans.map((plan) => plan.displayLabel));
			if (!selection) {
				return;
			}

			const selected = plans.find((plan) => plan.displayLabel === selection);
			if (!selected) {
				return;
			}

			const snapshot = await readSnapshot(selected.planPath);
			const edited = await ctx.ui.editor(`Plan Snapshot: ${path.basename(selected.planPath)}`, snapshot);
			if (edited === undefined) {
				return;
			}

			if (selected.planPath === getPlanLocation(ctx).planPath) {
				if (edited.trim() === "") {
					await clearPlanSnapshot(pi, ctx);
				} else {
					const current = await getCurrentPlanSnapshot(pi, ctx);
					await persistPlanSnapshot(pi, ctx, parseSnapshotBody(edited), parseSnapshotLabel(edited, current?.label || getDefaultLabel(pi, ctx)));
				}
			} else if (edited.trim() === "") {
				await deleteSnapshot(selected.planPath);
			} else {
				await writeSnapshot(selected.planPath, edited);
			}

			await refreshPlanUi(pi, ctx, isPlanModeEnabled(ctx));
			ctx.ui.notify(`Saved snapshot: ${selected.planPath}`, "success");
		},
	});
}
