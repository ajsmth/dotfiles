import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { complete, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type UiLevel = "info" | "success" | "warning" | "error";

type GitCommandContext = {
	cwd: string;
	hasUI: boolean;
	model?: {
		id: string;
		provider: string;
	};
	modelRegistry?: {
		getApiKeyAndHeaders(model: unknown): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>;
	};
	ui: {
		notify(message: string, level?: UiLevel): void;
		select?(title: string, options: string[]): Promise<string | null>;
		confirm?(title: string, message: string): Promise<boolean>;
		input?(title: string, placeholder?: string): Promise<string | null>;
	};
};

type GitExecResult = {
	stdout: string;
	stderr: string;
	code: number;
};

type DirtyBehavior = "abort" | "autostash" | "continue";

type SquashBehavior = "squash" | "keep" | "cancel";

type SquashRecoveryPlan = {
	backupBranch: string;
	stateDir: string;
	patchPath: string;
	metadataPath: string;
};

type PreflightPlan = {
	target: string;
	branch: string;
	base: string;
	commitCount: number;
	firstCommitSha?: string;
	dirty: boolean;
	dirtyBehavior: DirtyBehavior;
	squashBehavior: Exclude<SquashBehavior, "cancel">;
	recoveryPlan?: SquashRecoveryPlan;
};

type UpstreamRef = {
	remote: string;
	branch: string;
	fullRef: string;
};

const GIT_REBASE_STATE_ROOT = path.join(os.homedir(), ".local", "state", "pi", "git-rebase");
const SQUASH_COMMIT_SYSTEM_PROMPT = `You write concise git commit messages for squashed feature branches.

Rules:
- Use only the provided commit list and diff context.
- First line must be an imperative subject, <= 72 characters.
- Include a short body only if it adds useful context.
- Do not mention that this is AI-generated.
- Do not wrap the message in markdown or code fences.
- Output only the commit message.`;

function trim(text: string): string {
	return text.trim();
}

function truncateText(text: string, maxChars: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxChars) return trimmed;
	return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function sanitizeRefComponent(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "branch";
}

function timestampForRef(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

function normalizeTarget(rawArgs: string): string {
	const value = trim(rawArgs);
	if (!value) return "origin/main";
	if (value.includes("/") || value.startsWith("refs/")) return value;
	return `origin/${value}`;
}

async function runGit(pi: ExtensionAPI, cwd: string, args: string[], timeout = 30_000): Promise<GitExecResult> {
	const result = await pi.exec("git", args, { cwd, timeout });
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		code: result.code ?? 1,
	};
}

async function gitOutput(pi: ExtensionAPI, cwd: string, args: string[], timeout = 30_000): Promise<string> {
	const result = await runGit(pi, cwd, args, timeout);
	if (result.code !== 0) {
		throw new Error(trim(result.stderr || result.stdout || `git ${args.join(" ")} failed`));
	}
	return trim(result.stdout);
}

async function hasDirtyWorkingTree(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	const output = await gitOutput(pi, cwd, ["status", "--porcelain"]);
	return output.length > 0;
}

async function getCurrentBranch(pi: ExtensionAPI, cwd: string): Promise<string> {
	return gitOutput(pi, cwd, ["branch", "--show-current"]);
}

async function verifyGitRepo(pi: ExtensionAPI, cwd: string): Promise<void> {
	const result = await runGit(pi, cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (result.code !== 0 || trim(result.stdout) !== "true") {
		throw new Error("Current directory is not a git repository");
	}
}

async function verifyTargetExists(pi: ExtensionAPI, cwd: string, target: string): Promise<void> {
	const result = await runGit(pi, cwd, ["rev-parse", "--verify", "--quiet", `${target}^{commit}`]);
	if (result.code !== 0) {
		throw new Error(`Could not resolve git target: ${target}`);
	}
}

async function pathIsDirectory(value: string): Promise<boolean> {
	try {
		return (await stat(value)).isDirectory();
	} catch {
		return false;
	}
}

function resolveGitPath(cwd: string, value: string): string {
	return path.isAbsolute(value) ? value : path.join(cwd, value);
}

async function isRebaseInProgress(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	const rebaseMergePath = resolveGitPath(cwd, await gitOutput(pi, cwd, ["rev-parse", "--git-path", "rebase-merge"]));
	const rebaseApplyPath = resolveGitPath(cwd, await gitOutput(pi, cwd, ["rev-parse", "--git-path", "rebase-apply"]));
	return (await pathIsDirectory(rebaseMergePath)) || (await pathIsDirectory(rebaseApplyPath));
}

async function getMergeBase(pi: ExtensionAPI, cwd: string, target: string): Promise<string> {
	return gitOutput(pi, cwd, ["merge-base", "HEAD", target]);
}

async function getCommitCountSinceBase(pi: ExtensionAPI, cwd: string, base: string): Promise<number> {
	const output = await gitOutput(pi, cwd, ["rev-list", "--count", `${base}..HEAD`]);
	const count = Number.parseInt(output, 10);
	return Number.isFinite(count) ? count : 0;
}

async function getFirstCommitSinceBase(pi: ExtensionAPI, cwd: string, base: string): Promise<string | undefined> {
	const output = await gitOutput(pi, cwd, ["rev-list", "--reverse", `${base}..HEAD`]);
	return output.split("\n").map(trim).find(Boolean);
}

async function planSquashRecovery(pi: ExtensionAPI, cwd: string, branch: string): Promise<SquashRecoveryPlan> {
	const repoRoot = await gitOutput(pi, cwd, ["rev-parse", "--show-toplevel"]);
	const repoName = `${sanitizeRefComponent(path.basename(repoRoot))}-${createHash("sha1").update(repoRoot).digest("hex").slice(0, 8)}`;
	const timestamp = timestampForRef();
	const safeBranch = sanitizeRefComponent(branch);
	const stateDir = path.join(GIT_REBASE_STATE_ROOT, repoName, safeBranch, timestamp);
	return {
		backupBranch: `backup/pi-rebase/${safeBranch}/${timestamp}`,
		stateDir,
		patchPath: path.join(stateDir, "squash.patch"),
		metadataPath: path.join(stateDir, "metadata.json"),
	};
}

async function createSquashRecoverySnapshot(pi: ExtensionAPI, ctx: GitCommandContext, plan: PreflightPlan): Promise<void> {
	if (!plan.recoveryPlan) return;

	await mkdir(plan.recoveryPlan.stateDir, { recursive: true });
	const head = await gitOutput(pi, ctx.cwd, ["rev-parse", "HEAD"]);
	const branchResult = await runGit(pi, ctx.cwd, ["branch", plan.recoveryPlan.backupBranch, head], 60_000);
	if (branchResult.code !== 0) {
		throw new Error(trim(branchResult.stderr || branchResult.stdout || `Failed to create backup branch ${plan.recoveryPlan.backupBranch}`));
	}

	const patch = await gitOutput(pi, ctx.cwd, ["diff", "--binary", `${plan.base}..HEAD`], 120_000);
	await writeFile(plan.recoveryPlan.patchPath, `${patch.trimEnd()}\n`, "utf8");

	const commitLog = await gitOutput(pi, ctx.cwd, ["log", "--reverse", "--format=%H%x00%an%x00%ae%x00%ad%x00%s", "--date=iso-strict", `${plan.base}..HEAD`]);
	const commits = commitLog
		.split("\n")
		.map((line) => line.split("\u0000"))
		.filter((parts) => parts[0])
		.map(([sha, authorName, authorEmail, authorDate, subject]) => ({ sha, authorName, authorEmail, authorDate, subject }));
	const metadata = {
		createdAt: new Date().toISOString(),
		branch: plan.branch,
		target: plan.target,
		base: plan.base,
		head,
		commitCount: plan.commitCount,
		firstCommitSha: plan.firstCommitSha,
		backupBranch: plan.recoveryPlan.backupBranch,
		patchPath: plan.recoveryPlan.patchPath,
		commits,
	};
	await writeFile(plan.recoveryPlan.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

	ctx.ui.notify(`Created squash recovery backup ${plan.recoveryPlan.backupBranch}\nPatch: ${plan.recoveryPlan.patchPath}\nMetadata: ${plan.recoveryPlan.metadataPath}`, "success");
}

async function getCommitSubjectsSinceBase(pi: ExtensionAPI, cwd: string, base: string): Promise<string> {
	return gitOutput(pi, cwd, ["log", "--reverse", "--format=%s", `${base}..HEAD`]);
}

function normalizeCommitMessage(message: string): string | undefined {
	const cleaned = message
		.replace(/^```(?:gitcommit|text)?\s*/i, "")
		.replace(/```$/i, "")
		.trim();
	const [subjectLine, ...bodyLines] = cleaned.split(/\r?\n/);
	const subject = subjectLine?.trim();
	if (!subject) return undefined;
	const body = bodyLines.join("\n").trim();
	return body ? `${subject}\n\n${body}` : subject;
}

async function draftSquashCommitMessage(pi: ExtensionAPI, ctx: GitCommandContext, plan: PreflightPlan): Promise<string | undefined> {
	if (!ctx.model || !ctx.modelRegistry) {
		return undefined;
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok || !auth.apiKey) {
		return undefined;
	}

	const commitSubjects = await getCommitSubjectsSinceBase(pi, ctx.cwd, plan.base);
	const diffStat = await gitOutput(pi, ctx.cwd, ["diff", "--stat", `${plan.base}..HEAD`], 60_000);
	const nameStatus = await gitOutput(pi, ctx.cwd, ["diff", "--name-status", `${plan.base}..HEAD`], 60_000);
	const diff = await gitOutput(pi, ctx.cwd, ["diff", "--find-renames", `${plan.base}..HEAD`], 120_000);
	const userMessage: UserMessage = {
		role: "user",
		content: [
			{
				type: "text",
				text: [
					`Branch: ${plan.branch}`,
					`Rebase target: ${plan.target}`,
					"",
					"Commit subjects being squashed:",
					commitSubjects || "(none)",
					"",
					"Diff stat:",
					diffStat || "(none)",
					"",
					"Changed files:",
					nameStatus || "(none)",
					"",
					"Diff excerpt:",
					truncateText(diff, 18_000) || "(none)",
				].join("\n"),
			},
		],
		timestamp: Date.now(),
	};

	const response = await complete(
		ctx.model,
		{ systemPrompt: SQUASH_COMMIT_SYSTEM_PROMPT, messages: [userMessage] },
		{ apiKey: auth.apiKey, headers: auth.headers },
	);
	if (response.stopReason === "aborted") {
		return undefined;
	}
	const text = response.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	return normalizeCommitMessage(text);
}

async function promptSelect(ctx: GitCommandContext, title: string, options: string[]): Promise<string | null> {
	if (!ctx.hasUI || !ctx.ui.select) return null;
	return ctx.ui.select(title, options);
}

async function promptConfirm(ctx: GitCommandContext, title: string, message: string): Promise<boolean> {
	if (!ctx.hasUI || !ctx.ui.confirm) return false;
	return ctx.ui.confirm(title, message);
}

async function promptInput(ctx: GitCommandContext, title: string, placeholder?: string): Promise<string | null> {
	if (!ctx.hasUI || !ctx.ui.input) return null;
	return ctx.ui.input(title, placeholder);
}

async function promptDirtyBehavior(ctx: GitCommandContext): Promise<DirtyBehavior | undefined> {
	const choice = await promptSelect(ctx, "Working tree has local changes", ["Abort", "Auto-stash", "Continue anyway"]);
	if (!choice || choice === "Abort") return "abort";
	if (choice === "Auto-stash") return "autostash";
	return "continue";
}

async function promptSquashBehavior(ctx: GitCommandContext, commitCount: number): Promise<SquashBehavior> {
	const choice = await promptSelect(ctx, `Branch has ${commitCount} commits`, ["Squash all into one", "Keep commits", "Cancel"]);
	if (!choice || choice === "Cancel") return "cancel";
	if (choice === "Squash all into one") return "squash";
	return "keep";
}

async function createAutostash(pi: ExtensionAPI, cwd: string): Promise<string> {
	const marker = `pi-git-rebase-autostash-${Date.now()}`;
	const push = await runGit(pi, cwd, ["stash", "push", "-u", "-m", marker], 60_000);
	if (push.code !== 0) {
		throw new Error(trim(push.stderr || push.stdout || "Failed to create git stash"));
	}
	const list = await gitOutput(pi, cwd, ["stash", "list", "--format=%gd%x00%gs"]);
	const match = list
		.split("\n")
		.map(trim)
		.find((line) => line.includes(marker));
	if (!match) {
		throw new Error("Created auto-stash but could not find its ref");
	}
	return match.split("\u0000")[0] || "stash@{0}";
}

async function squashBranchToOneCommit(pi: ExtensionAPI, cwd: string, base: string, firstCommitSha: string, commitMessage?: string): Promise<void> {
	const reset = await runGit(pi, cwd, ["reset", "--soft", base], 60_000);
	if (reset.code !== 0) {
		throw new Error(trim(reset.stderr || reset.stdout || "Failed to prepare squash commit"));
	}

	const commitArgs = commitMessage
		? (() => {
			const [subjectLine, ...bodyLines] = commitMessage.split(/\r?\n/);
			const subject = subjectLine?.trim() || "Squash branch changes";
			const body = bodyLines.join("\n").trim();
			return body ? ["commit", "-m", subject, "-m", body] : ["commit", "-m", subject];
		})()
		: ["commit", "--reuse-message", firstCommitSha, "--reset-author"];
	const commit = await runGit(pi, cwd, commitArgs, 60_000);
	if (commit.code !== 0) {
		throw new Error(trim(commit.stderr || commit.stdout || "Failed to create squash commit"));
	}
}

async function listConflictedFiles(pi: ExtensionAPI, cwd: string): Promise<string[]> {
	const output = await gitOutput(pi, cwd, ["diff", "--name-only", "--diff-filter=U"]);
	return output ? output.split("\n").map(trim).filter(Boolean) : [];
}

async function handleConflictHandoff(args: {
	pi: ExtensionAPI;
	ctx: GitCommandContext;
	branch: string;
	target: string;
	stage: "rebase" | "stash-pop";
	stashRef?: string;
}): Promise<void> {
	const { pi, ctx, branch, target, stage, stashRef } = args;
	const conflictedFiles = await listConflictedFiles(pi, ctx.cwd);
	const summary = conflictedFiles.length > 0 ? conflictedFiles.join("\n") : "(could not determine conflicted files)";
	const message =
		stage === "rebase"
			? `Rebase onto ${target} hit conflicts on ${branch}.\n\nConflicted files:\n${summary}\n\nAsk pi to try resolving them?`
			: `Applying auto-stash ${stashRef ?? ""} created conflicts after rebasing ${branch} onto ${target}.\n\nConflicted files:\n${summary}\n\nAsk pi to try resolving them?`;
	const shouldManage = await promptConfirm(ctx, "Git conflicts detected", message);
	if (!shouldManage) {
		ctx.ui.notify("Resolve conflicts manually when ready", "warning");
		return;
	}

	const prompt = stage === "rebase"
		? [
			`A git rebase onto ${target} is in progress on branch ${branch}.`,
			"Please inspect the repository, resolve the merge conflicts in the working tree, stage the resolved files, and continue the rebase with `git -c core.editor=true rebase --continue`.",
			"Do not use plain `git rebase --continue`, because it may block waiting for an editor.",
			"If a safe resolution is not obvious, explain the blockers and stop instead of guessing.",
		].join("\n\n")
		: [
			`A git rebase onto ${target} completed on branch ${branch}, but applying auto-stash ${stashRef ?? ""} caused conflicts.`,
			"Please inspect the repository, resolve the merge conflicts in the working tree, and leave the branch in a clean state.",
			"If a safe resolution is not obvious, explain the blockers and stop instead of guessing.",
		].join("\n\n");

	pi.sendUserMessage(prompt);
	ctx.ui.notify("Asked pi to help resolve git conflicts", "info");
}

async function getUpstreamRef(pi: ExtensionAPI, cwd: string): Promise<UpstreamRef | undefined> {
	const result = await runGit(pi, cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
	if (result.code !== 0) {
		return undefined;
	}
	const fullRef = trim(result.stdout);
	const slashIndex = fullRef.indexOf("/");
	if (slashIndex === -1) {
		return undefined;
	}
	return {
		remote: fullRef.slice(0, slashIndex),
		branch: fullRef.slice(slashIndex + 1),
		fullRef,
	};
}

async function localBranchExists(pi: ExtensionAPI, cwd: string, branch: string): Promise<boolean> {
	const result = await runGit(pi, cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
	return result.code === 0;
}

async function renameLocalBranch(pi: ExtensionAPI, cwd: string, newName: string): Promise<void> {
	const result = await runGit(pi, cwd, ["branch", "-m", newName], 60_000);
	if (result.code !== 0) {
		throw new Error(trim(result.stderr || result.stdout || `Failed to rename branch to ${newName}`));
	}
}

async function pushRenamedBranch(pi: ExtensionAPI, cwd: string, remote: string, newName: string): Promise<void> {
	const result = await runGit(pi, cwd, ["push", "-u", remote, `${newName}:${newName}`], 120_000);
	if (result.code !== 0) {
		throw new Error(trim(result.stderr || result.stdout || `Failed to push ${newName} to ${remote}`));
	}
}

async function deleteRemoteBranch(pi: ExtensionAPI, cwd: string, remote: string, branch: string): Promise<void> {
	const result = await runGit(pi, cwd, ["push", remote, "--delete", branch], 120_000);
	if (result.code !== 0) {
		throw new Error(trim(result.stderr || result.stdout || `Failed to delete remote branch ${remote}/${branch}`));
	}
}

async function handleBranchRename(pi: ExtensionAPI, ctx: GitCommandContext, rawName: string): Promise<void> {
	await verifyGitRepo(pi, ctx.cwd);
	const currentBranch = await getCurrentBranch(pi, ctx.cwd);
	if (!currentBranch) {
		throw new Error("Not on a local branch (detached HEAD)");
	}

	let newName = trim(rawName);
	if (!newName) {
		const input = await promptInput(ctx, "Rename branch", "New branch name");
		if (!input) {
			ctx.ui.notify("Cancelled branch rename", "info");
			return;
		}
		newName = trim(input);
	}

	if (!newName) {
		throw new Error("Branch name cannot be empty");
	}
	if (newName === currentBranch) {
		throw new Error(`Branch is already named ${newName}`);
	}
	if (await localBranchExists(pi, ctx.cwd, newName)) {
		throw new Error(`A local branch named ${newName} already exists`);
	}

	const upstream = await getUpstreamRef(pi, ctx.cwd);
	const summary = [
		`Current branch: ${currentBranch}`,
		`New name: ${newName}`,
		`Upstream: ${upstream?.fullRef ?? "none"}`,
	].join("\n");
	const confirmed = ctx.hasUI ? await promptConfirm(ctx, "Confirm branch rename", summary) : true;
	if (!confirmed) {
		ctx.ui.notify("Cancelled branch rename", "info");
		return;
	}

	await renameLocalBranch(pi, ctx.cwd, newName);
	ctx.ui.notify(`Renamed local branch ${currentBranch} → ${newName}`, "success");

	if (!upstream) {
		return;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify(`Local branch renamed. Upstream still points to ${upstream.fullRef}`, "info");
		return;
	}

	const remoteChoice = await promptSelect(ctx, "Remote branch rename", [
		"Local only",
		`Push ${newName} and keep ${upstream.remote}/${upstream.branch}`,
		`Push ${newName} and delete ${upstream.remote}/${upstream.branch}`,
	]);
	if (!remoteChoice || remoteChoice === "Local only") {
		ctx.ui.notify(`Remote branch unchanged: ${upstream.fullRef}`, "info");
		return;
	}

	await pushRenamedBranch(pi, ctx.cwd, upstream.remote, newName);
	if (remoteChoice.includes("delete")) {
		await deleteRemoteBranch(pi, ctx.cwd, upstream.remote, upstream.branch);
		ctx.ui.notify(`Renamed branch locally and on ${upstream.remote}`, "success");
		return;
	}
	ctx.ui.notify(`Pushed ${newName} to ${upstream.remote}; old remote branch kept`, "success");
}

async function buildPreflightPlan(pi: ExtensionAPI, ctx: GitCommandContext, rawArgs: string): Promise<PreflightPlan | undefined> {
	const target = normalizeTarget(rawArgs);
	await verifyGitRepo(pi, ctx.cwd);
	if (await isRebaseInProgress(pi, ctx.cwd)) {
		throw new Error("A git rebase is already in progress. Finish or abort it before starting a new one.");
	}
	await verifyTargetExists(pi, ctx.cwd, target);

	const branch = await getCurrentBranch(pi, ctx.cwd);
	const base = await getMergeBase(pi, ctx.cwd, target);
	const commitCount = await getCommitCountSinceBase(pi, ctx.cwd, base);
	const firstCommitSha = commitCount > 0 ? await getFirstCommitSinceBase(pi, ctx.cwd, base) : undefined;
	const dirty = await hasDirtyWorkingTree(pi, ctx.cwd);

	let dirtyBehavior: DirtyBehavior = "continue";
	if (dirty) {
		if (!ctx.hasUI) {
			throw new Error("Working tree has local changes. Run interactively to choose abort, auto-stash, or continue anyway.");
		}
		dirtyBehavior = (await promptDirtyBehavior(ctx)) ?? "abort";
		if (dirtyBehavior === "abort") {
			ctx.ui.notify("Cancelled git rebase", "info");
			return undefined;
		}
	}

	let squashBehavior: Exclude<SquashBehavior, "cancel"> = "keep";
	if (commitCount > 1) {
		if (!ctx.hasUI) {
			throw new Error("Branch has multiple commits. Run interactively to choose whether to squash before rebasing.");
		}
		const chosen = await promptSquashBehavior(ctx, commitCount);
		if (chosen === "cancel") {
			ctx.ui.notify("Cancelled git rebase", "info");
			return undefined;
		}
		squashBehavior = chosen;
	}

	if (dirty && dirtyBehavior === "continue" && squashBehavior === "squash") {
		const choice = await promptSelect(ctx, "Squash with local changes is risky", [
			"Auto-stash and continue",
			"Keep commits",
			"Cancel",
		]);
		if (!choice || choice === "Cancel") {
			ctx.ui.notify("Cancelled git rebase", "info");
			return undefined;
		}
		if (choice === "Auto-stash and continue") {
			dirtyBehavior = "autostash";
		} else {
			squashBehavior = "keep";
		}
	}

	const recoveryPlan = squashBehavior === "squash" ? await planSquashRecovery(pi, ctx.cwd, branch) : undefined;
	const summary = [
		`Branch: ${branch}`,
		`Target: ${target}`,
		`Local changes: ${dirty ? dirtyBehavior : "clean working tree"}`,
		`Branch commits: ${commitCount}`,
		`Squash before rebase: ${squashBehavior === "squash" ? "yes" : "no"}`,
		recoveryPlan ? `Recovery backup branch: ${recoveryPlan.backupBranch}` : undefined,
		recoveryPlan ? `Recovery patch: ${recoveryPlan.patchPath}` : undefined,
		recoveryPlan ? `Recovery metadata: ${recoveryPlan.metadataPath}` : undefined,
	].filter((line): line is string => typeof line === "string").join("\n");
	const confirmed = ctx.hasUI ? await promptConfirm(ctx, "Confirm git rebase", summary) : true;
	if (!confirmed) {
		ctx.ui.notify("Cancelled git rebase", "info");
		return undefined;
	}

	return {
		target,
		branch,
		base,
		commitCount,
		firstCommitSha,
		dirty,
		dirtyBehavior,
		squashBehavior,
		recoveryPlan,
	};
}

export default function gitExtension(pi: ExtensionAPI): void {
	pi.registerCommand("git", {
		description: "Git helpers",
		getArgumentCompletions: (prefix) => {
			const trimmed = prefix.trimStart();
			if (!trimmed) {
				return [
					{ value: "rebase", label: "rebase" },
					{ value: "branch", label: "branch" },
				];
			}
			if (!trimmed.includes(" ")) {
				const items = ["rebase", "branch"];
				const filtered = items.filter((item) => item.startsWith(trimmed.toLowerCase()));
				return filtered.length > 0 ? filtered.map((item) => ({ value: item, label: item })) : null;
			}
			if (trimmed === "branch " || trimmed.startsWith("branch ")) {
				const remainder = trimmed.slice("branch ".length);
				if (!remainder || !remainder.includes(" ")) {
					const items = ["rename"];
					const filtered = items.filter((item) => item.startsWith(remainder.toLowerCase()));
					return filtered.length > 0 ? filtered.map((item) => ({ value: `branch ${item}`, label: `branch ${item}` })) : null;
				}
			}
			return null;
		},
		handler: async (rawArgs, ctx) => {
			const trimmed = trim(rawArgs);
			const [subcommand, second, ...restParts] = trimmed ? trimmed.split(/\s+/) : [""];
			const rest = second ? restParts.join(" ") : "";

			if (!subcommand) {
				ctx.ui.notify("Usage: /git rebase [target] | /git branch rename [name]", "info");
				return;
			}

			if (subcommand === "branch") {
				if (second !== "rename") {
					ctx.ui.notify("Usage: /git branch rename [name]", "warning");
					return;
				}
				try {
					await handleBranchRename(pi, ctx as GitCommandContext, restParts.join(" "));
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}

			if (subcommand !== "rebase") {
				ctx.ui.notify(`Unknown /git subcommand: ${subcommand}`, "warning");
				return;
			}

			try {
				const plan = await buildPreflightPlan(pi, ctx as GitCommandContext, second ? [second, ...restParts].join(" ") : "");
				if (!plan) return;

				let stashRef: string | undefined;
				if (plan.dirty && plan.dirtyBehavior === "autostash") {
					ctx.ui.notify("Creating auto-stash...", "info");
					stashRef = await createAutostash(pi, ctx.cwd);
				}

				if (plan.squashBehavior === "squash") {
					if (!plan.firstCommitSha) {
						throw new Error("Could not determine first branch commit to squash");
					}
					await createSquashRecoverySnapshot(pi, ctx as GitCommandContext, plan);
					ctx.ui.notify("Drafting squash commit message...", "info");
					const commitMessage = await draftSquashCommitMessage(pi, ctx as GitCommandContext, plan);
					ctx.ui.notify(commitMessage ? `Using AI squash commit message:\n${commitMessage}` : "Could not draft an AI commit message; reusing the first commit message.", commitMessage ? "info" : "warning");
					ctx.ui.notify("Squashing branch commits into one...", "info");
					await squashBranchToOneCommit(pi, ctx.cwd, plan.base, plan.firstCommitSha, commitMessage);
				}

				ctx.ui.notify(`Rebasing ${plan.branch} onto ${plan.target}...`, "info");
				const rebase = await runGit(pi, ctx.cwd, ["rebase", plan.target], 300_000);
				if (rebase.code !== 0) {
					const conflictedFiles = await listConflictedFiles(pi, ctx.cwd);
					if (conflictedFiles.length > 0) {
						await handleConflictHandoff({
							pi,
							ctx: ctx as GitCommandContext,
							branch: plan.branch,
							target: plan.target,
							stage: "rebase",
							stashRef,
						});
						return;
					}
					throw new Error(trim(rebase.stderr || rebase.stdout || "git rebase failed"));
				}

				if (stashRef) {
					ctx.ui.notify(`Restoring auto-stash ${stashRef}...`, "info");
					const pop = await runGit(pi, ctx.cwd, ["stash", "pop", stashRef], 120_000);
					if (pop.code !== 0) {
						const conflictedFiles = await listConflictedFiles(pi, ctx.cwd);
						if (conflictedFiles.length > 0) {
							await handleConflictHandoff({
								pi,
								ctx: ctx as GitCommandContext,
								branch: plan.branch,
								target: plan.target,
								stage: "stash-pop",
								stashRef,
							});
							return;
						}
						throw new Error(trim(pop.stderr || pop.stdout || `Failed to restore auto-stash ${stashRef}`));
					}
				}

				ctx.ui.notify(`Rebased ${plan.branch} onto ${plan.target}`, "success");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
