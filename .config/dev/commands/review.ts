import { spawnSync } from 'node:child_process';

type Host = {
  registerCommand(definition: HostCommandDefinition): void;
  setStatus(message: string): void;
  withLoading<T>(label: string, action: () => Promise<T> | T): Promise<T>;
  showModal(options: HostModalOptions): Promise<HostModalResult>;
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
    argsWords: string[];
  }): Promise<void> | void;
};

type HostModalItem = {
  title: string;
  subtitle?: string;
  value?: string;
};

type HostModalOptions = {
  title: string;
  items: HostModalItem[];
  emptyMessage?: string;
  help?: string;
  searchable?: boolean;
};

type HostModalResult = {
  action: 'primary' | 'secondary' | 'open' | 'refresh' | 'cancel';
  item?: HostModalItem;
  index: number;
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
  baseRefName: string | null;
};

type ReviewDefinition = {
  id: string;
  title: string;
  subtitle: string;
  prompts: string[];
  instruction: string;
  defaultSelected?: boolean;
  aliases?: string[];
};

type ReviewContext = {
  branch: string;
  repoRoot: string;
  baseRef: string;
  diffStat: string;
  changedFiles: string;
  handoffNotes: string;
  pr: PrSummary | null;
  selectedReviews: ReviewDefinition[];
};

const RUN_SELECTED = '__run_selected__';
const TOGGLE_ALL = '__toggle_all__';

const REVIEW_DEFINITIONS: ReviewDefinition[] = [
  {
    id: 'coderabbit',
    title: 'CodeRabbit',
    subtitle: 'AI review tuned for PR-style implementation feedback',
    prompts: ['$coderabbit:code-review'],
    instruction: 'Run CodeRabbit review on the local branch diff and report actionable findings.',
    defaultSelected: true,
    aliases: ['rabbit', 'code-rabbit'],
  },
  {
    id: 'differential',
    title: 'Differential Review',
    subtitle: 'Security-focused review of changed behavior',
    prompts: ['$differential-review'],
    instruction: 'Perform a differential review of the branch against the base ref, prioritizing regressions, security issues, and missing tests.',
    defaultSelected: true,
    aliases: ['diff', 'differential-review'],
  },
  {
    id: 'second-opinion',
    title: 'Second Opinion',
    subtitle: 'Independent LLM review of the same change set',
    prompts: ['$second-opinion'],
    instruction: 'Run an independent second-opinion review over the uncommitted/branch changes and compare its findings with the other reviews.',
    defaultSelected: true,
    aliases: ['second', 'opinion'],
  },
  {
    id: 'semgrep',
    title: 'Semgrep',
    subtitle: 'Static analysis for security and bug patterns',
    prompts: ['$static-analysis:semgrep'],
    instruction: 'Run Semgrep when the repository language and tooling make it practical; include true positives and suppress obvious noise.',
    aliases: ['static', 'static-analysis'],
  },
  {
    id: 'sharp-edges',
    title: 'Sharp Edges',
    subtitle: 'Dangerous APIs, risky configuration, and footguns',
    prompts: ['$sharp-edges', '$insecure-defaults'],
    instruction: 'Look for dangerous defaults, risky APIs, permissive configuration, and other footguns introduced or exposed by this diff.',
    aliases: ['security', 'defaults', 'insecure-defaults'],
  },
  {
    id: 'ci-parity',
    title: 'CI Parity',
    subtitle: 'Local checks likely to fail CI',
    prompts: [],
    instruction: 'Inspect package scripts, CI config, and changed files, then run focused local checks likely to catch CI failures before submit.',
    defaultSelected: true,
    aliases: ['ci', 'checks', 'tests'],
  },
];

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

function parsePr(raw: string): PrSummary | null {
  const value = JSON.parse(raw) as {
    number?: unknown;
    title?: unknown;
    url?: unknown;
    baseRefName?: unknown;
  };

  if (typeof value.number !== 'number' || typeof value.url !== 'string') {
    return null;
  }

  return {
    number: value.number,
    title: typeof value.title === 'string' ? value.title : '',
    url: value.url,
    baseRefName: typeof value.baseRefName === 'string' ? value.baseRefName : null,
  };
}

function currentPr(repoRoot: string): PrSummary | null {
  const result = spawnSync('gh', ['pr', 'view', '--json', 'number,title,url,baseRefName'], {
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

function refExists(repoRoot: string, ref: string | null | undefined): ref is string {
  return typeof ref === 'string' && ref.length > 0 && git(['rev-parse', '--verify', '--quiet', ref], repoRoot, true).status === 0;
}

function resolveBaseRef(repoRoot: string, pr: PrSummary | null): string {
  const originHead = git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], repoRoot, true).stdout.trim();
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], repoRoot, true).stdout.trim();
  const candidates = [
    pr?.baseRefName ? `origin/${pr.baseRefName}` : null,
    pr?.baseRefName,
    originHead,
    'origin/main',
    'origin/master',
    'main',
    'master',
    upstream,
    'HEAD~1',
  ];

  for (const candidate of candidates) {
    if (refExists(repoRoot, candidate)) {
      return candidate;
    }
  }

  return 'HEAD~1';
}

function compactPathList(value: string, limit = 8): string {
  const lines = value.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    return 'none';
  }

  const visible = lines.slice(0, limit).join('\n');
  const remaining = lines.length - limit;
  return remaining > 0 ? `${visible}\n... +${remaining} more` : visible;
}

function reviewById(id: string): ReviewDefinition | undefined {
  return REVIEW_DEFINITIONS.find((review) => review.id === id);
}

function reviewMatches(review: ReviewDefinition, word: string): boolean {
  const normalized = word.toLowerCase();
  return review.id === normalized || review.aliases?.includes(normalized) === true;
}

function initialSelection(argsWords: string[]): Set<string> {
  const selected = new Set(REVIEW_DEFINITIONS.filter((review) => review.defaultSelected).map((review) => review.id));
  if (argsWords.length === 0) {
    return selected;
  }

  selected.clear();
  for (const word of argsWords) {
    if (word === 'all') {
      REVIEW_DEFINITIONS.forEach((review) => selected.add(review.id));
      continue;
    }

    const review = REVIEW_DEFINITIONS.find((candidate) => reviewMatches(candidate, word));
    if (review) {
      selected.add(review.id);
    }
  }

  return selected.size > 0 ? selected : new Set(REVIEW_DEFINITIONS.filter((review) => review.defaultSelected).map((review) => review.id));
}

function modalItems(selected: Set<string>): HostModalItem[] {
  const selectedCount = selected.size;
  return [
    {
      title: selectedCount > 0 ? `Run selected (${selectedCount})` : 'Run selected',
      subtitle: selectedCount > 0 ? 'Start the agent handoff with these reviews' : 'Select at least one review first',
      value: RUN_SELECTED,
    },
    {
      title: selected.size === REVIEW_DEFINITIONS.length ? 'Clear all' : 'Select all',
      subtitle: 'Toggle every review option',
      value: TOGGLE_ALL,
    },
    ...REVIEW_DEFINITIONS.map((review) => ({
      title: `${selected.has(review.id) ? '[x]' : '[ ]'} ${review.title}`,
      subtitle: review.subtitle,
      value: review.id,
    })),
  ];
}

async function selectReviews(host: Host, argsWords: string[]): Promise<ReviewDefinition[] | null> {
  const selected = initialSelection(argsWords);

  while (true) {
    const result = await host.showModal({
      title: 'Select reviews',
      items: modalItems(selected),
      searchable: true,
      help: 'Enter toggle/run  / search  q cancel',
    });

    if (result.action === 'cancel' || !result.item?.value) {
      host.setStatus('review cancelled');
      return null;
    }

    if (result.item.value === RUN_SELECTED) {
      if (selected.size === 0) {
        host.setStatus('select at least one review');
        continue;
      }

      return [...selected].map((id) => reviewById(id)).filter((review): review is ReviewDefinition => Boolean(review));
    }

    if (result.item.value === TOGGLE_ALL) {
      if (selected.size === REVIEW_DEFINITIONS.length) {
        selected.clear();
      } else {
        REVIEW_DEFINITIONS.forEach((review) => selected.add(review.id));
      }
      continue;
    }

    if (selected.has(result.item.value)) {
      selected.delete(result.item.value);
    } else {
      selected.add(result.item.value);
    }
  }
}

async function readReviewContext(host: Host, handoffNotes: string, selectedReviews: ReviewDefinition[]): Promise<ReviewContext> {
  const context = await host.withLoading('Reading review context', () => {
    const repoRoot = gitOutput(['rev-parse', '--show-toplevel']);
    const branch = gitOutput(['branch', '--show-current'], repoRoot);
    if (!branch) {
      throw new Error('Current HEAD is detached. Check out a branch before using :review.');
    }

    const pr = currentPr(repoRoot);
    const baseRef = resolveBaseRef(repoRoot, pr);
    return {
      branch,
      repoRoot,
      baseRef,
      diffStat: git(['diff', '--shortstat', `${baseRef}...HEAD`], repoRoot, true).stdout.trim(),
      changedFiles: git(['diff', '--name-status', `${baseRef}...HEAD`], repoRoot, true).stdout.trim(),
      pr,
    };
  });

  return {
    ...context,
    diffStat: context.diffStat || 'No branch changes detected',
    changedFiles: compactPathList(context.changedFiles),
    handoffNotes,
    selectedReviews,
  };
}

function reviewPrompt(context: ReviewContext): string {
  const prompts = [...new Set(context.selectedReviews.flatMap((review) => review.prompts))];
  const promptHeader = prompts.length > 0 ? [...prompts, ''] : [];

  return [
    ...promptHeader,
    'Context from :review:',
    `- repo: ${context.repoRoot}`,
    `- branch: ${context.branch}`,
    `- compare: ${context.baseRef}...HEAD`,
    context.pr
      ? `- current PR: #${context.pr.number} ${context.pr.title} (${context.pr.url})`
      : '- current PR: none found locally; review local branch changes',
    context.handoffNotes
      ? `- user handoff notes: ${context.handoffNotes}`
      : '- user handoff notes: none provided',
    `- diff stat: ${context.diffStat}`,
    '',
    'Changed files:',
    context.changedFiles,
    '',
    'Run the selected pre-submit reviews before CI is triggered. Run independent reviews/checks in parallel whenever practical, then consolidate the findings.',
    '',
    'Selected reviews:',
    ...context.selectedReviews.map((review) => `- ${review.title}: ${review.instruction}`),
    '',
    'Review rules:',
    '- Focus on actionable bugs, regressions, security issues, missing tests, and likely CI failures.',
    '- Treat formatter-only, stylistic, stale, duplicate, or speculative findings as non-blocking noise unless they create a real risk.',
    '- Do not commit, push, open a PR, or update Linear from this handoff.',
    '- If a selected review finds an issue that can be fixed safely, make the focused code change and run the narrowest relevant verification.',
    '- If the requested review type is unavailable in this repo or tool session, say that explicitly and continue with the remaining selected reviews.',
    '- Finish with a concise consolidated report grouped by review type, including verification commands and any unresolved risks.',
  ].join('\n');
}

export function register(host: Host): void {
  host.registerCommand({
    command: 'review',
    description: 'choose local pre-submit reviews and hand them to the agent',
    aliases: ['code-review', 'lint'],
    handoff: {
      prompts: [
        '$coderabbit:code-review',
        '$differential-review',
        '$second-opinion',
        '$static-analysis:semgrep',
        '$sharp-edges',
        '$insecure-defaults',
      ],
    },
    handler: async ({ args, argsWords }) => {
      host.setStatus('selecting reviews');
      const selectedReviews = await selectReviews(host, argsWords);
      if (!selectedReviews) {
        return;
      }

      const context = await readReviewContext(host, args, selectedReviews);
      host.setStatus(`handoff sent: ${selectedReviews.map((review) => review.id).join(', ')}`);
      host.log('command.inject', {
        command: 'review',
        branch: context.branch,
        repoRoot: context.repoRoot,
        baseRef: context.baseRef,
        reviews: selectedReviews.map((review) => review.id),
        pr: context.pr?.number,
      });
      host.inject(reviewPrompt(context));
    },
  });
}
