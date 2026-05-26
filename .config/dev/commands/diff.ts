import { spawnSync } from 'node:child_process';

type Host = {
  registerCommand(definition: HostCommandDefinition): void;
  setStatus(message: string): void;
  withSuspendedScreen<T>(action: () => Promise<T> | T): Promise<T>;
  log(event: string, details?: Record<string, unknown>): void;
};

type HostCommandDefinition = {
  command: string;
  description: string;
  handler(context: {
    argsWords: string[];
  }): Promise<void> | void;
};

type RunResult = {
  status: number;
  stdout: string;
  stderr: string;
};

type DiffResolution = {
  query: string;
  files: string[];
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

function commandPath(name: string): string {
  return `${process.env.HOME ?? ''}/.codex/skills/open-dif/scripts/${name}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, '\'\\\'\'')}'`;
}

function shellJoin(values: string[]): string {
  return values.map(shellQuote).join(' ');
}

function tmuxOption(name: string, fallback: string): string {
  const result = spawnSync('tmux', ['show-option', '-gqv', name], {
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  if (result.status !== 0 || typeof result.stdout !== 'string') {
    return fallback;
  }

  return result.stdout.trim() || fallback;
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function searchTokens(value: string): string[] {
  const ignored = new Set([
    'a',
    'an',
    'and',
    'are',
    'around',
    'change',
    'changes',
    'changeset',
    'diff',
    'diffs',
    'file',
    'files',
    'for',
    'in',
    'is',
    'just',
    'matching',
    'named',
    'of',
    'only',
    'open',
    'related',
    'show',
    'that',
    'the',
    'to',
    'touching',
  ]);

  return normalizeSearchText(value)
    .split(/\s+/)
    .filter((token) => token.length > 1 && !ignored.has(token));
}

function looksLikeDirectDiffArgs(words: string[]): boolean {
  return words.some((word) => (
    word.startsWith('-') ||
    word.includes('/') ||
    word.includes('.') ||
    word === 'against'
  ));
}

function diffSearchQuery(words: string[]): string | null {
  if (words.length === 0 || looksLikeDirectDiffArgs(words)) {
    return null;
  }

  const markers = [
    ['related', 'to'],
    ['for'],
    ['about'],
    ['around'],
    ['touching'],
    ['matching'],
    ['named'],
  ];

  for (const marker of markers) {
    for (let index = 0; index <= words.length - marker.length; index += 1) {
      if (marker.every((word, markerIndex) => words[index + markerIndex]?.toLowerCase() === word)) {
        const query = words.slice(index + marker.length).join(' ').trim();
        return query || null;
      }
    }
  }

  const tokens = searchTokens(words.join(' '));
  return tokens.length > 0 ? tokens.join(' ') : null;
}

function repoFiles(repoRoot: string): string[] {
  const result = git(['ls-files', '--cached', '--others', '--exclude-standard'], repoRoot, true);
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function contentMatches(repoRoot: string, query: string, tokens: string[]): Map<string, number> {
  const scores = new Map<string, number>();
  const searches = [
    { value: query, score: 40 },
    ...tokens.map((token) => ({ value: token, score: 10 })),
  ];

  for (const search of searches) {
    const result = spawnSync('rg', ['--files-with-matches', '--ignore-case', '--fixed-strings', search.value], {
      cwd: repoRoot,
      env: process.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0 || typeof result.stdout !== 'string') {
      continue;
    }

    for (const file of result.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
      scores.set(file, (scores.get(file) ?? 0) + search.score);
    }
  }

  return scores;
}

function resolveDiffFiles(repoRoot: string, query: string): string[] {
  const tokens = searchTokens(query);
  if (tokens.length === 0) {
    return [];
  }

  const normalizedQuery = normalizeSearchText(query);
  const scores = new Map<string, number>();

  for (const file of repoFiles(repoRoot)) {
    const normalizedPath = normalizeSearchText(file);
    const basename = normalizeSearchText(file.split('/').pop() ?? file);
    let score = 0;

    if (normalizedPath.includes(normalizedQuery)) score += 100;
    if (basename.includes(normalizedQuery)) score += 120;

    for (const token of tokens) {
      if (normalizedPath.includes(token)) score += 15;
      if (basename.includes(token)) score += 30;
      if (normalizedPath.split(' ').includes(token)) score += 35;
    }

    if (score > 0) {
      scores.set(file, score);
    }
  }

  for (const [file, score] of contentMatches(repoRoot, query, tokens)) {
    scores.set(file, (scores.get(file) ?? 0) + score);
  }

  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 20)
    .map(([file]) => file);
}

function resolveDiffQuery(words: string[], cwd: string): DiffResolution | null {
  const query = diffSearchQuery(words);
  if (!query) {
    return null;
  }

  const repoRoot = gitOutput(['rev-parse', '--show-toplevel'], cwd);
  const files = resolveDiffFiles(repoRoot, query);
  return files.length > 0 ? { query, files } : null;
}

function openDiffInFloax(title: string, command: string): boolean {
  if (!process.env.TMUX || spawnSync('tmux', ['display-message', '-p', '#{session_name}'], {
    env: process.env,
    stdio: ['ignore', 'ignore', 'ignore'],
  }).status !== 0) {
    return false;
  }

  const sessionName = `dev-dif-${process.pid}`;
  spawnSync('tmux', ['kill-session', '-t', `=${sessionName}`], {
    env: process.env,
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  const newSession = spawnSync('tmux', ['new-session', '-d', '-s', sessionName, '-c', process.cwd(), command], {
    env: process.env,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  if (newSession.status !== 0) {
    return false;
  }

  spawnSync('tmux', ['set-option', '-t', sessionName, 'status', 'off'], {
    env: process.env,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  spawnSync('tmux', ['set-option', '-t', sessionName, 'detach-on-destroy', 'on'], {
    env: process.env,
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  const popup = spawnSync('tmux', [
    'popup',
    '-S', `fg=${tmuxOption('@floax-border-color', 'magenta')}`,
    '-s', `fg=${tmuxOption('@floax-text-color', 'blue')}`,
    '-T', title,
    '-w', tmuxOption('@floax-width', '90%'),
    '-h', tmuxOption('@floax-height', '90%'),
    '-b', 'rounded',
    '-E',
    `tmux attach-session -t ${shellQuote(sessionName)}`,
  ], {
    env: process.env,
    stdio: 'inherit',
  });

  if (popup.status !== 0) {
    spawnSync('tmux', ['kill-session', '-t', `=${sessionName}`], {
      env: process.env,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return false;
  }

  return true;
}

function runDiffCommand(words: string[]): void {
  const script = commandPath('open-dif.sh');
  const args: string[] = [];
  const difArgs: string[] = [];
  const joined = words.join(' ').toLowerCase();
  let title = 'dif';
  let floaxCommand = 'dif';

  if (joined.includes('last message') || joined === 'message') {
    title = 'dif message';
    floaxCommand = `CODEX_THREAD_ID=${shellQuote(process.env.CODEX_THREAD_ID ?? '')} dip`;
    args.push('--message', process.cwd());
  } else {
    const againstIndex = words.indexOf('against');
    if (againstIndex !== -1 && words[againstIndex + 1]) {
      difArgs.push(words[againstIndex + 1]);
      args.push('--against', words[againstIndex + 1], process.cwd());
    } else {
      const resolution = resolveDiffQuery(words, process.cwd());
      args.push(process.cwd());
      if (resolution) {
        difArgs.push('--all-files');
        for (const file of resolution.files) {
          difArgs.push('--only', file);
        }
        args.push('--', ...difArgs);
        title = `dif ${resolution.query}`;
      } else if (words.length > 0) {
        difArgs.push(...words);
        args.push('--', ...words);
      }
    }

    floaxCommand = difArgs.length > 0 ? `dif ${shellJoin(difArgs)}` : 'dif';
  }

  if (!openDiffInFloax(title, floaxCommand)) {
    spawnSync('bash', [script, ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    });
  }
}

export function register(host: Host): void {
  host.registerCommand({
    command: 'diff',
    description: 'open dif/revdiff in floax when inside tmux',
    handler: async ({ argsWords }) => {
      host.log('command.diff', { words: argsWords });
      await host.withSuspendedScreen(() => runDiffCommand(argsWords));
      host.setStatus('returned from diff');
    },
  });
}
