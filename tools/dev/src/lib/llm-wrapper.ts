import { accessSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

interface LlmWrapperOptions {
  command: string;
  args: string[];
  prefix: string;
  bracketedPaste: boolean;
  logPath?: string;
}

function canAccess(pathname: string): boolean {
  try {
    accessSync(pathname);
    return true;
  } catch {
    return false;
  }
}

function wrapperCandidates(): string[] {
  const sourceDistRelative = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../bin/llm-wrapper.js',
  );
  const sourceTsRelative = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../bin/llm-wrapper.ts',
  );
  const cwdRelative = path.resolve(process.cwd(), 'tools/dev/dist/bin/llm-wrapper.js');
  const homeRelative = path.join(process.env.HOME ?? '', 'dotfiles/tools/dev/dist/bin/llm-wrapper.js');
  const explicit = process.env.DEV_CLI_LLM_WRAPPER;

  return [explicit, sourceDistRelative, sourceTsRelative, cwdRelative, homeRelative].filter((value): value is string => Boolean(value));
}

function resolveWrapper(): string {
  const wrapper = wrapperCandidates().find(canAccess);
  if (!wrapper) {
    throw new Error('Could not find tools/dev/dist/bin/llm-wrapper.js. Run `bun run build` in tools/dev or set DEV_CLI_LLM_WRAPPER.');
  }

  return wrapper;
}

export async function runLlmWrapper(options: LlmWrapperOptions): Promise<void> {
  const wrapper = resolveWrapper();
  const runner = wrapper.endsWith('.ts') ? 'tsx' : 'node';
  const result = spawnSync(runner, [wrapper, options.command, ...options.args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DEV_LLM_PREFIX: options.prefix,
      DEV_LLM_BRACKETED_PASTE: options.bracketedPaste ? '1' : '0',
      ...(options.logPath ? { DEV_LLM_LOG: options.logPath } : {}),
    },
    stdio: 'inherit',
  });

  if (result.error) {
    throw new Error(`Failed to run ${runner} wrapper: ${result.error.message}`);
  }

  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }

  if (result.signal) {
    throw new Error(`LLM wrapper exited from signal ${result.signal}`);
  }
}
