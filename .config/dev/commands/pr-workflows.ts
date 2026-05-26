import { spawnSync } from 'node:child_process';

type Host = {
  registerCommand(definition: HostCommandDefinition): void;
  setStatus(message: string): void;
  withLoading<T>(label: string, action: () => Promise<T> | T): Promise<T>;
  inject(text: string): void;
  log(event: string, details?: Record<string, unknown>): void;
};

type HostCommandDefinition = {
  command: string;
  description: string;
  handoff?: {
    prompts: string[];
  };
  handler(context: {
    args: string;
  }): Promise<void> | void;
};

type RunResult = {
  status: number;
  stdout: string;
  stderr: string;
};

type PrContext = {
  branch: string;
  repoRoot: string;
  handoffNotes: string;
  pr: {
    number: number;
    title: string;
    url: string;
  } | null;
  linearIssue: string | null;
};

function clean(value: string): string {
  return value.trim();
}

function run(command: string, args: string[], options: { cwd?: string; allowFailure?: boolean } = {}): RunResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: process.env,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (result.error) {
    throw new Error(`Failed to run ${command}: ${result.error.message}`);
  }

  const status = result.status ?? 1;
  const output = {
    status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };

  if (status !== 0 && options.allowFailure !== true) {
    throw new Error(output.stderr.trim() || `${command} ${args.join(' ')} failed with status ${status}`);
  }

  return output;
}

function git(args: string[], cwd?: string, allowFailure = false): RunResult {
  return run('git', args, { cwd, allowFailure });
}

function gitOutput(args: string[], cwd?: string): string {
  return clean(git(args, cwd).stdout);
}

function parsePr(raw: string): PrContext['pr'] {
  const value = JSON.parse(raw) as {
    number?: unknown;
    title?: unknown;
    url?: unknown;
  };

  if (typeof value.number !== 'number' || typeof value.url !== 'string') {
    return null;
  }

  return {
    number: value.number,
    title: typeof value.title === 'string' ? value.title : '',
    url: value.url,
  };
}

function currentPr(repoRoot: string): PrContext['pr'] {
  const result = spawnSync('gh', ['pr', 'view', '--json', 'number,title,url'], {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 3000,
  });

  if (result.error || result.status !== 0 || typeof result.stdout !== 'string' || result.stdout.trim() === '') {
    return null;
  }

  return parsePr(result.stdout);
}

function inferLinearIssue(branch: string): string | null {
  return branch.match(/[A-Z][A-Z0-9]+-\d+/)?.[0] ?? null;
}

async function readPrContext(host: Host, command: string, handoffNotes: string): Promise<PrContext> {
  const { repoRoot, branch } = await host.withLoading(`Preparing :${command}`, () => {
    const repoRoot = gitOutput(['rev-parse', '--show-toplevel']);
    const branch = gitOutput(['branch', '--show-current'], repoRoot);
    return { repoRoot, branch };
  });
  if (!branch) {
    throw new Error(`Current HEAD is detached. Check out a branch before using :${command}.`);
  }

  const { pr, linearIssue } = await host.withLoading('Reading PR context', () => ({
    pr: currentPr(repoRoot),
    linearIssue: inferLinearIssue(branch),
  }));

  return {
    branch,
    repoRoot,
    handoffNotes,
    pr,
    linearIssue,
  };
}

function prCheckPrompt(context: PrContext): string {
  return [
    '$git comments',
    '$ticket',
    '',
    'Context from :pr check:',
    `- repo: ${context.repoRoot}`,
    `- branch: ${context.branch}`,
    context.pr
      ? `- current PR: #${context.pr.number} ${context.pr.title} (${context.pr.url})`
      : '- current PR: none found locally; use gh to resolve the current PR if possible',
    context.linearIssue
      ? `- possible Linear ticket: ${context.linearIssue}`
      : '- possible Linear ticket: none inferred',
    context.handoffNotes
      ? `- user handoff notes: ${context.handoffNotes}`
      : '- user handoff notes: none provided',
    '',
    'Use Andrew\'s git comments workflow:',
    '- Fetch current PR issue comments, inline review comments, and submitted reviews with gh.',
    '- Fetch current GitHub check runs/statuses and CI annotations or logs for failing, cancelled, timed-out, or flaky jobs. Prefer gh commands/API over unauthenticated network access.',
    '- Summarize CI feedback separately from human review feedback before making changes, including the job/check name, failure signal, likely affected area, and any concise actionable error text.',
    '- Determine which feedback is relevant and actionable.',
    '- Watch for repeated feedback patterns; if similar issues keep recurring, change strategy instead of applying another isolated fix.',
    '- If there is confusion, ambiguity, suspect behavior, unclear product intent, or reviewer preference, pause and ask the user how to proceed.',
    '- Otherwise inspect the code, make the relevant changes, run focused checks when practical, commit with conventional commit syntax, push, update the PR if significant, and include the PR URL in the final response.',
    '- In the final response, include a short "Feedback addressed" summary that separates human review feedback from CI feedback, so the user can see which CI signal was handled.',
    '- After the PR is resubmitted or confirmed current, use Andrew\'s ticket workflow if a ticket is associated: update status/comment only when appropriate and include the ticket URL in the final response.',
  ].join('\n');
}

function prMergePrompt(context: PrContext): string {
  return [
    '$git comments',
    '$ticket',
    '',
    'Context from :pr merge:',
    `- repo: ${context.repoRoot}`,
    `- branch: ${context.branch}`,
    context.pr
      ? `- current PR: #${context.pr.number} ${context.pr.title} (${context.pr.url})`
      : '- current PR: none found locally; use gh to resolve the current PR if possible',
    context.linearIssue
      ? `- possible Linear ticket: ${context.linearIssue}`
      : '- possible Linear ticket: none inferred',
    context.handoffNotes
      ? `- user handoff notes: ${context.handoffNotes}`
      : '- user handoff notes: none provided',
    '',
    'Use Andrew\'s git and ticket workflows to safely queue this PR for merge:',
    '- Use authenticated gh commands to fetch the current PR state, checks/statuses, issue comments, inline review comments, submitted reviews, labels, mergeability, and branch state.',
    '- Assess whether it is safe to merge. Treat unresolved or ambiguous human feedback, failing required checks, merge conflicts, repository/branch-protection requirements to update the branch, product ambiguity, or suspicious bot state as not safe; ask the user instead of queueing.',
    '- A branch merely being behind the target branch is not by itself a reason to rebase or avoid mergequeue. Rebase/update only when GitHub reports conflicts, branch protection requires the branch to be up to date, required checks are stale/missing because of the behind state, or the user asks for it.',
    '- If you need to rebase, merge, update from the target branch, or resolve conflicts before queueing, treat conflict resolution as a high-risk change.',
    '- When resolving conflicts, compare the resolved files against the merge base, the PR side, and the target branch side. Do not restore code that the target branch intentionally removed unless the PR explicitly still requires it.',
    '- After any conflict resolution, inspect the final diff and confirm every changed hunk is directly related to the PR or the conflict. If unrelated code appears, revert that hunk or ask the user before proceeding.',
    '- Identify any submitted CHANGE_REQUESTED reviews that are blocking merge. Dismiss only reviews that are clearly obsolete because the requested changes were addressed or superseded, and only when the review ID is available.',
    '- Dismiss obsolete submitted reviews with GitHub API, for example: gh api -X PUT repos/OWNER/REPO/pulls/PR_NUMBER/reviews/REVIEW_ID/dismissals -f message="Addressed in latest push".',
    '- Do not remove or dismiss active, unresolved, or ambiguous change requests.',
    '- Once the PR is assessed safe, add the merge queue label with: gh pr edit PR_NUMBER --add-label "mergequeue".',
    '- After adding the label, poll with gh about every 30 seconds until the PR is merged, closed without merge, or a clear blocker appears. Keep the poll long-running rather than asking the user to monitor it manually.',
    '- When the PR is confirmed merged, use Andrew\'s ticket workflow to infer/read the Linear ticket and move it to Done unless the issue workflow clearly uses a different completed status.',
    '- Add a concise ticket comment with implemented/testing/PR context only from the PR or local facts. Do not invent testing.',
    '- Final response must include the PR URL and ticket URL/status when available.',
  ].join('\n');
}

function prStartPrompt(context: PrContext): string {
  return [
    '$ticket',
    '$git',
    '$design',
    '',
    'Context from :pr start:',
    `- repo: ${context.repoRoot}`,
    `- branch: ${context.branch}`,
    context.pr
      ? `- current PR: #${context.pr.number} ${context.pr.title} (${context.pr.url})`
      : '- current PR: none found locally; this is expected when starting work',
    context.linearIssue
      ? `- possible Linear ticket: ${context.linearIssue}`
      : '- possible Linear ticket: none inferred',
    context.handoffNotes
      ? `- user handoff notes: ${context.handoffNotes}`
      : '- user handoff notes: none provided',
    '',
    'Use Andrew\'s ticket workflow to start this work:',
    '- Identify and read the Linear ticket. If no ticket is clear, or multiple tickets are plausible, ask the user which ticket to use before changing Linear.',
    '- Move the ticket to the in-progress engineering status, using the exact workflow status named "In Progress (Eng)" when available.',
    '- Read the ticket description, comments, linked resources, related/blocked/duplicate issues, and any specs or documents referenced by the ticket.',
    '- Apply Andrew\'s design workflow. Look for Figma/design links in the ticket, comments, related issues, specs, PRs, branch naming, and repo docs.',
    '- If relevant Figma designs are found, note their URLs/names/node context in the implementation plan and call out that implementation should use the Figma MCP/design context before coding UI.',
    '- If the work appears UI-facing but no design is found, call that out as an open question instead of inventing design details.',
    '- Look for recent related PRs or commits in this repo using the ticket key, branch naming, linked resources, or similar title/feature wording.',
    '- If the ticket/spec/context is thin or no direct related work is found, inspect recently merged PRs in this repository with gh for adjacent product areas, shared files, similar titles, or implementation patterns that may inform the plan.',
    '- Include any relevant recently merged PRs in the context summary with why they matter; ignore unrelated merged PRs rather than padding the plan.',
    '- Summarize the relevant product/technical context, constraints, related work, and open questions.',
    '- Produce a concrete implementation plan that the user can review and iterate on before code changes begin.',
    '- Do not implement until the user confirms the plan or asks you to proceed.',
  ].join('\n');
}

export function register(host: Host): void {
  host.registerCommand({
    command: 'pr check',
    description: 'fetch PR and CI feedback, then address clear items',
    handoff: {
      prompts: ['$git comments', '$ticket'],
    },
    handler: async ({ args }) => {
      host.setStatus('preparing PR check');
      const context = await readPrContext(host, 'pr check', args);
      host.setStatus(context.pr ? `checking PR #${context.pr.number}` : 'checking current PR');
      host.log('command.inject', {
        command: 'pr check',
        branch: context.branch,
        repoRoot: context.repoRoot,
        pr: context.pr?.number,
        linearIssue: context.linearIssue,
      });
      host.inject(prCheckPrompt(context));
    },
  });

  host.registerCommand({
    command: 'pr merge',
    description: 'verify safety, queue merge, then update ticket',
    handoff: {
      prompts: ['$git comments', '$ticket'],
    },
    handler: async ({ args }) => {
      host.setStatus('preparing PR merge');
      const context = await readPrContext(host, 'pr merge', args);
      host.setStatus(context.pr ? `preparing PR #${context.pr.number} for merge` : 'preparing current PR for merge');
      host.log('command.inject', {
        command: 'pr merge',
        branch: context.branch,
        repoRoot: context.repoRoot,
        pr: context.pr?.number,
        linearIssue: context.linearIssue,
      });
      host.inject(prMergePrompt(context));
    },
  });

  host.registerCommand({
    command: 'pr start',
    description: 'start ticket work, gather context, and plan',
    handoff: {
      prompts: ['$ticket', '$git', '$design'],
    },
    handler: async ({ args }) => {
      host.setStatus('preparing PR start');
      const context = await readPrContext(host, 'pr start', args);
      host.setStatus(context.linearIssue ? `starting ${context.linearIssue}` : 'starting ticket work');
      host.log('command.inject', {
        command: 'pr start',
        branch: context.branch,
        repoRoot: context.repoRoot,
        pr: context.pr?.number,
        linearIssue: context.linearIssue,
      });
      host.inject(prStartPrompt(context));
    },
  });
}
