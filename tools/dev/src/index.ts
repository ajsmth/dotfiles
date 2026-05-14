#!/usr/bin/env node

import { Command } from 'commander';

import { dotfilesCommand } from './commands/dotfiles.js';
import { gitCommand } from './commands/git.js';
import { llmCommand } from './commands/llm.js';
import { printCliError } from './lib/ui.js';

const program = new Command();

program
  .name('dev')
  .description('Personal workflow CLI')
  .showHelpAfterError()
  .option('--debug', 'Show stack traces for command failures');

program.addCommand(dotfilesCommand);
program.addCommand(gitCommand);
program.addCommand(llmCommand);

try {
  await program.parseAsync(process.argv);
} catch (error) {
  printCliError(error, {
    debug: process.argv.includes('--debug'),
  });
  process.exit(1);
}
