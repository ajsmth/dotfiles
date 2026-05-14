import { Command } from 'commander';

import { runLlmHost } from '../lib/llm-host.js';

interface HostCommandOptions {
  prefix: string;
  noBracketedPaste?: boolean;
}

export const hostCommand = new Command('host')
  .description('Run an LLM CLI inside the dev-host terminal viewport')
  .argument('<cli>', 'Native LLM CLI to run, for example codex')
  .argument('[args...]', 'Arguments passed through to the native CLI')
  .option('--prefix <prefix>', 'Local command prefix', ':')
  .option('--no-bracketed-paste', 'Inject command output without bracketed paste')
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(async (cli: string, args: string[], options: HostCommandOptions) => {
    await runLlmHost({
      command: cli,
      args,
      prefix: options.prefix,
      bracketedPaste: options.noBracketedPaste !== true,
    });
  });
