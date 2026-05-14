import { Command } from 'commander';

import { rebaseOntoOrigin, submitChanges, summarizeComments } from '../lib/git.js';
import type { LlmBackend } from '../lib/llm.js';

type SquashMode = 'ask' | 'always' | 'never';

interface RebaseCommandOptions {
  target?: string;
  remote: string;
  baseBranch?: string;
  fetch: boolean;
  squash: SquashMode;
  aiConflicts: boolean;
  backend?: LlmBackend;
  model?: string;
}

interface SubmitCommandOptions {
  remote: string;
  baseBranch?: string;
  fetch: boolean;
  draft: boolean;
  agent: boolean;
  yes: boolean;
  title?: string;
  body?: string;
  bodyFile?: string;
  backend?: LlmBackend;
  model?: string;
}

interface CommentsCommandOptions {
  raw: boolean;
  agent: boolean;
  backend?: LlmBackend;
  model?: string;
}

function parseSquashMode(value: string): SquashMode {
  if (value === 'ask' || value === 'always' || value === 'never') {
    return value;
  }

  throw new Error('Expected --squash to be one of: ask, always, never');
}

function parseBackend(value: string): LlmBackend {
  if (value === 'openai' || value === 'ollama') {
    return value;
  }

  throw new Error('Expected --backend to be one of: openai, ollama');
}

export const gitCommand = new Command('git')
  .description('Git workflow helpers');

gitCommand
  .command('rebase')
  .description('Fetch origin and rebase the current branch onto origin/default')
  .option('--target <ref>', 'Explicit rebase target, for example origin/main')
  .option('--remote <name>', 'Remote to fetch and inspect for the default branch', 'origin')
  .option('--base-branch <branch>', 'Remote branch name to use when --target is omitted')
  .option('--no-fetch', 'Skip git fetch before rebasing')
  .option('--squash <mode>', 'Squash mode: ask, always, or never', parseSquashMode, 'ask')
  .option('--no-ai-conflicts', 'Do not attempt LLM conflict resolution')
  .option('--backend <backend>', 'LLM backend: openai or ollama', parseBackend)
  .option('--model <model>', 'LLM model override')
  .action(async (options: RebaseCommandOptions) => {
    await rebaseOntoOrigin({
      target: options.target,
      remote: options.remote,
      baseBranch: options.baseBranch,
      fetch: options.fetch,
      squashMode: options.squash,
      aiConflicts: options.aiConflicts,
      backend: options.backend,
      model: options.model,
    });
  });

gitCommand
  .command('submit')
  .description('Commit local changes, push the branch, and create or update a GitHub PR')
  .option('--remote <name>', 'Remote to push and inspect for the default branch', 'origin')
  .option('--base-branch <branch>', 'Pull request base branch')
  .option('--no-fetch', 'Skip git fetch before submitting')
  .option('--draft', 'Create a draft pull request when opening a new PR')
  .option('--agent', 'Run non-interactively and emit JSON output')
  .option('--yes', 'Accept safe defaults in non-interactive mode, including staging all local changes')
  .option('--title <title>', 'Conventional commit title / PR title override')
  .option('--body <body>', 'PR body and commit body override')
  .option('--body-file <path>', 'Read PR body and commit body override from a file')
  .option('--backend <backend>', 'LLM backend: openai or ollama', parseBackend)
  .option('--model <model>', 'LLM model override')
  .action(async (options: SubmitCommandOptions) => {
    await submitChanges({
      remote: options.remote,
      baseBranch: options.baseBranch,
      fetch: options.fetch,
      draft: options.draft,
      agent: options.agent,
      yes: options.yes,
      title: options.title,
      body: options.body,
      bodyFile: options.bodyFile,
      backend: options.backend,
      model: options.model,
    });
  });

gitCommand
  .command('comments')
  .description('Fetch current PR comments and summarize actionable feedback')
  .option('--raw', 'Print fetched comment payload without LLM summarization')
  .option('--agent', 'Run non-interactively and emit JSON output')
  .option('--backend <backend>', 'LLM backend: openai or ollama', parseBackend)
  .option('--model <model>', 'LLM model override')
  .action(async (options: CommentsCommandOptions) => {
    await summarizeComments({
      raw: options.raw,
      agent: options.agent,
      backend: options.backend,
      model: options.model,
    });
  });
