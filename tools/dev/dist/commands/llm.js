import { Command } from 'commander';
import { runLlmHost } from '../lib/llm-host.js';
export const llmCommand = new Command('llm')
    .description('Run an LLM CLI inside the dev terminal viewport')
    .argument('<cli>', 'Native LLM CLI to run, for example codex')
    .argument('[args...]', 'Arguments passed through to the native CLI')
    .option('--prefix <prefix>', 'Local command prefix', ':')
    .option('--no-bracketed-paste', 'Inject command output without bracketed paste')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(async (cli, args, options) => {
    await runLlmHost({
        command: cli,
        args,
        prefix: options.prefix,
        bracketedPaste: options.noBracketedPaste !== true,
    });
});
