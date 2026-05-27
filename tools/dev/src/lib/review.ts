import { run } from './process.js';
import { printKeyValue, printSection, step } from './ui.js';

interface ReviewOptions {
  remote: string;
  baseBranch?: string;
  fetch: boolean;
  agent: boolean;
}

function git(args: string[], cwd?: string, allowFailure = false) {
  return run('git', args, { cwd, allowFailure });
}

function gitOutput(args: string[], cwd?: string): string {
  return git(args, cwd).stdout.trim();
}

function fail(message: string): never {
  throw new Error(message);
}

async function maybeStep<T>(agent: boolean, label: string, action: () => Promise<T>): Promise<T> {
  return agent ? action() : step(label, action);
}

function currentBranch(repoRoot: string): string {
  const branch = gitOutput(['branch', '--show-current'], repoRoot);
  if (!branch) {
    fail('Current HEAD is detached. Check out a branch before reviewing.');
  }

  return branch;
}

function resolveDefaultBranch(repoRoot: string, remote: string): string {
  const remoteHead = git(['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`], repoRoot, true);
  const remoteHeadName = remoteHead.stdout.trim();
  if (remoteHead.status === 0 && remoteHeadName.startsWith(`${remote}/`)) {
    return remoteHeadName.slice(remote.length + 1);
  }

  if (git(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/main`], repoRoot, true).status === 0) {
    return 'main';
  }

  if (git(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/master`], repoRoot, true).status === 0) {
    return 'master';
  }

  fail(`Could not resolve ${remote}'s default branch.`);
}

export async function reviewLocalChanges(options: ReviewOptions): Promise<void> {
  const repoRoot = gitOutput(['rev-parse', '--show-toplevel']);
  const branch = currentBranch(repoRoot);

  if (options.fetch) {
    await maybeStep(options.agent, `Fetching ${options.remote}`, async () => {
      git(['fetch', options.remote, '--prune'], repoRoot);
    });
  }

  const baseBranch = options.baseBranch ?? resolveDefaultBranch(repoRoot, options.remote);
  const target = `${options.remote}/${baseBranch}`;

  if (branch === baseBranch) {
    fail(`Cannot review from ${branch}. Switch to a feature branch first.`);
  }

  // Get diff stats
  const diffStat = await maybeStep(options.agent, 'Analyzing changes', async () => {
    const stat = gitOutput(['diff', '--shortstat', `${target}...HEAD`], repoRoot);
    const files = gitOutput(['diff', '--name-status', `${target}...HEAD`], repoRoot);
    const numFiles = files.split('\n').filter(Boolean).length;

    return { stat, numFiles };
  });

  if (!options.agent) {
    console.log('');
    printSection('Local Code Review');
    printKeyValue('Branch', branch);
    printKeyValue('Base', target);
    printKeyValue('Files Changed', String(diffStat.numFiles));
    printKeyValue('Stats', diffStat.stat || 'No changes');
    console.log('');
  }

  // Run codex review
  const codexResult = await maybeStep(options.agent, 'Running Codex review', async () => {
    return run('codex', ['review', '--non-interactive', `${target}...HEAD`], {
      cwd: repoRoot,
      allowFailure: true,
    });
  });

  // Run coderabbit review (via plugin)
  const coderabbitResult = await maybeStep(options.agent, 'Running CodeRabbit review', async () => {
    // Try running coderabbit via codex plugin
    return run('codex', ['exec', '/coderabbit', `review ${target}...HEAD`], {
      cwd: repoRoot,
      allowFailure: true,
    });
  });

  if (options.agent) {
    console.log(JSON.stringify({
      kind: 'dev.git.review',
      branch,
      base: target,
      filesChanged: diffStat.numFiles,
      codexReview: {
        exitCode: codexResult.status,
        output: codexResult.stdout,
      },
      coderabbitReview: {
        exitCode: coderabbitResult.status,
        output: coderabbitResult.stdout,
      },
    }, null, 2));
    return;
  }

  console.log('');
  printSection('Review Results');

  if (codexResult.status === 0) {
    console.log('✓ Codex review passed');
    if (codexResult.stdout.trim()) {
      console.log(codexResult.stdout);
    }
  } else {
    console.log('✗ Codex review found issues:');
    console.log(codexResult.stderr || codexResult.stdout);
  }

  console.log('');

  if (coderabbitResult.status === 0) {
    console.log('✓ CodeRabbit review passed');
    if (coderabbitResult.stdout.trim()) {
      console.log(coderabbitResult.stdout);
    }
  } else {
    console.log('✗ CodeRabbit review found issues:');
    console.log(coderabbitResult.stderr || coderabbitResult.stdout);
  }

  // Exit with non-zero if either review failed
  if (codexResult.status !== 0 || coderabbitResult.status !== 0) {
    process.exit(1);
  }
}
