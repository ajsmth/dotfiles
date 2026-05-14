import { Command } from 'commander';

import { runLlmWrapper } from '../lib/llm-wrapper.js';

interface LlmCommandOptions {
  prefix: string;
  noBracketedPaste?: boolean;
  log?: string;
}

export const llmCommand = new Command('llm')
  .description('Run an LLM CLI with local interactive :commands')
  .argument('<cli>', 'Native LLM CLI to run, for example codex')
  .argument('[args...]', 'Arguments passed through to the native CLI')
  .option('--prefix <prefix>', 'Local command prefix', ':')
  .option('--no-bracketed-paste', 'Inject command output without bracketed paste')
  .option('--log <path>', 'Write wrapper debug logs to this path')
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(async (cli: string, args: string[], options: LlmCommandOptions) => {
    await runLlmWrapper({
      command: cli,
      args,
      prefix: options.prefix,
      bracketedPaste: options.noBracketedPaste !== true,
      logPath: options.log,
    });
  });
