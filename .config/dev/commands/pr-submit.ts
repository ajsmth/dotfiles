import { spawnSync } from 'node:child_process';
import { stdout } from 'node:process';

type Host = {
  registerCommand(definition: HostCommandDefinition): void;
  setStatus(message: string): void;
  confirm(label: string, defaultValue: boolean): Promise<boolean | 'cancel'>;
  confirmModal(options: HostConfirmModalOptions): Promise<boolean | 'cancel'>;
  withLoading<T>(label: string, action: () => Promise<T> | T): Promise<T>;
  inject(text: string): void;
  log(event: string, details?: Record<string, unknown>): void;
};

type HostCommandDefinition = {
  command: string;
  description: string;
  aliases?: string[];
  handoff?: {
    prompts: string[];
  };
  handler(context: {
    args: string;
  }): Promise<void> | void;
};

type HostConfirmModalOptions = {
  title: string;
  message: string;
  details?: string[];
  defaultValue?: boolean;
  yesLabel?: string;
  noLabel?: string;
};

type RunResult = {
  status: number;
  stdout: string;
  stderr: string;
};

type PrSummary = {
  number: number;
  title: string;
  url: string;
};

type PrSubmitContext = {
  branch: string;
  repoRoot: string;
  handoffNotes: string;
  stagedFiles: string;
  unstagedFiles: string;
  stageAll: 'yes' | 'no' | 'not-needed';
  pr: PrSummary | null;
  linearIssue: string | null;
};

const HANDOFF_PROMPTS = ['$git submit', '$ticket'];

function clean(value: string): string {
  return value.trim();
}

function color(code: string, value: string): string {
  return stdout.isTTY ? `\x1b[${code}m${value}\x1b[0m` : value;
}

function green(value: string): string {
  return color('32', value);
}

function yellow(value: string): string {
  return color('33', value);
}

function magenta(value: string): string {
  return color('35', value);
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

function parsePr(raw: string): PrSummary | null {
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

function currentPr(repoRoot: string): PrSummary | null {
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

function hasUnstagedOrUntracked(status: string): boolean {
  return status
    .split('\n')
    .filter(Boolean)
    .some((line) => line.startsWith('??') || line[1] !== ' ');
}

function hasStaged(status: string): boolean {
  return status
    .split('\n')
    .filter(Boolean)
    .some((line) => !line.startsWith('??') && line[0] !== ' ');
}

function statusEntries(status: string): { staged: string[]; unstaged: string[]; untracked: string[] } {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];

  for (const line of status.split('\n').filter(Boolean)) {
    const pathspec = line.slice(2).trimStart();
    if (line.startsWith('??')) {
      untracked.push(pathspec);
      continue;
    }

    if (line[0] !== ' ') {
      staged.push(`${line[0]} ${pathspec}`);
    }

    if (line[1] !== ' ') {
      unstaged.push(`${line[1]} ${pathspec}`);
    }
  }

  return { staged, unstaged, untracked };
}

function compactPathList(values: string[], limit = 3): string {
  if (values.length === 0) {
    return 'none';
  }

  const visible = values.slice(0, limit).join(', ');
  const remaining = values.length - limit;
  return remaining > 0 ? `${visible}, +${remaining} more` : visible;
}

function formatMaybeEmpty(value: string): string {
  return value.trim() || 'none';
}

function prSubmitPrompt(context: PrSubmitContext): string {
  return [
    ...HANDOFF_PROMPTS,
    '',
    'Context from :pr submit:',
    `- repo: ${context.repoRoot}`,
    `- branch: ${context.branch}`,
    `- user chose to stage all: ${context.stageAll}`,
    '- user approved handoff to Codex: yes',
    context.pr
      ? `- current PR: #${context.pr.number} ${context.pr.title} (${context.pr.url})`
      : '- current PR: none found',
    context.linearIssue
      ? `- possible Linear ticket: ${context.linearIssue}`
      : '- possible Linear ticket: none inferred',
    context.handoffNotes
      ? `- user handoff notes: ${context.handoffNotes}`
      : '- user handoff notes: none provided',
    '',
    'Staged files:',
    formatMaybeEmpty(context.stagedFiles),
    '',
    'Unstaged/untracked files:',
    formatMaybeEmpty(context.unstagedFiles),
    '',
    'Use Andrew\'s git rules to inspect the changes, create a conventional commit if needed, push the branch, and create or update the PR.',
    'After the PR is created or updated and the final PR URL is known, trigger a fresh bot review round for both CodeRabbit and Codex using the project\'s PR review workflow. If that workflow is unavailable, post the equivalent PR comments: @coderabbit review and /codex review.',
    'If a Linear ticket is associated with this work, use Andrew\'s ticket workflow conservatively: update status toward review/PR when appropriate, add a concise important update comment only when useful, and include the ticket URL in the final response.',
  ].join('\n');
}

export function register(host: Host): void {
  host.registerCommand({
    command: 'pr submit',
    description: 'stage changes, then create or update the PR',
    aliases: ['pr update'],
    handoff: {
      prompts: HANDOFF_PROMPTS,
    },
    handler: async ({ args }) => {
      host.setStatus('preparing PR submit');
      const { repoRoot, branch, statusBefore, entriesBefore } = await host.withLoading('Inspecting git status', () => {
        const repoRoot = gitOutput(['rev-parse', '--show-toplevel']);
        const branch = gitOutput(['branch', '--show-current'], repoRoot);
        const statusBefore = gitOutput(['status', '--porcelain', '--untracked-files=all'], repoRoot);
        const entriesBefore = statusEntries(statusBefore);
        return { repoRoot, branch, statusBefore, entriesBefore };
      });
      if (!branch) {
        throw new Error('Current HEAD is detached. Check out a branch before using :pr submit.');
      }

      let stageAll: PrSubmitContext['stageAll'] = 'not-needed';
      host.setStatus([
        `${branch}`,
        `${green(`${entriesBefore.staged.length} staged`)}`,
        `${yellow(`${entriesBefore.unstaged.length} unstaged`)}`,
        `${magenta(`${entriesBefore.untracked.length} untracked`)}`,
        `staged: ${compactPathList(entriesBefore.staged)}`,
      ].join('  '));

      if (hasUnstagedOrUntracked(statusBefore)) {
        const shouldStageAll = await host.confirmModal({
          title: 'Stage changes?',
          message: 'Stage all unstaged and untracked changes before submitting?',
          details: [
            `Branch: ${branch}`,
            `${entriesBefore.staged.length} staged, ${entriesBefore.unstaged.length} unstaged, ${entriesBefore.untracked.length} untracked`,
            `Staged: ${compactPathList(entriesBefore.staged)}`,
            `Unstaged: ${compactPathList(entriesBefore.unstaged)}`,
            `Untracked: ${compactPathList(entriesBefore.untracked)}`,
          ],
          defaultValue: true,
          yesLabel: 'Stage all',
          noLabel: 'Leave as-is',
        });
        if (shouldStageAll === 'cancel') {
          host.setStatus('cancelled');
          return;
        }

        stageAll = shouldStageAll ? 'yes' : 'no';
        if (shouldStageAll) {
          await host.withLoading('Staging changes', () => git(['add', '-A'], repoRoot));
        }
      }

      const { statusAfter, stagedFiles, unstagedFiles, untrackedFiles } = await host.withLoading('Reading final change set', () => ({
        statusAfter: gitOutput(['status', '--porcelain', '--untracked-files=all'], repoRoot),
        stagedFiles: git(['diff', '--cached', '--name-status'], repoRoot, true).stdout.trim(),
        unstagedFiles: git(['diff', '--name-status'], repoRoot, true).stdout.trim(),
        untrackedFiles: git(['ls-files', '--others', '--exclude-standard'], repoRoot, true).stdout.trim(),
      }));
      const handoffDefault = hasStaged(statusAfter) || stageAll === 'yes';
      const { pr, linearIssue } = await host.withLoading('Reading PR context', () => ({
        pr: currentPr(repoRoot),
        linearIssue: inferLinearIssue(branch),
      }));
      const handoffApproved = await host.confirmModal({
        title: 'Submit PR handoff?',
        message: 'Send this change set to Codex as $git submit?',
        details: [
          `Branch: ${branch}`,
          pr ? `Current PR: #${pr.number} ${pr.title}` : 'Current PR: none found',
          linearIssue ? `Linear issue: ${linearIssue}` : 'Linear issue: none inferred',
          `Stage all: ${stageAll}`,
          `Staged files: ${compactPathList(stagedFiles.split('\n').filter(Boolean))}`,
          `Remaining unstaged: ${compactPathList([unstagedFiles, untrackedFiles].join('\n').split('\n').filter(Boolean))}`,
          'After submit: trigger CodeRabbit and Codex review round',
        ],
        defaultValue: handoffDefault,
        yesLabel: 'Send',
        noLabel: 'Cancel',
      });
      if (handoffApproved === 'cancel' || !handoffApproved) {
        host.setStatus('cancelled');
        return;
      }

      host.setStatus('handoff sent');
      host.log('command.inject', { command: 'pr submit', branch, repoRoot, pr: pr?.number, linearIssue });
      host.inject(prSubmitPrompt({
        branch,
        repoRoot,
        handoffNotes: args,
        stagedFiles,
        unstagedFiles: [unstagedFiles, untrackedFiles].filter(Boolean).join('\n'),
        stageAll,
        pr,
        linearIssue,
      }));
    },
  });
}
