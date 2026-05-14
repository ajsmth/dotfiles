import { Command } from 'commander';
import { syncDotfiles } from '../lib/dotfiles.js';
export const dotfilesCommand = new Command('dotfiles')
    .description('Dotfiles workflow helpers');
dotfilesCommand
    .command('sync')
    .description('Restow dotfiles into $HOME')
    .action(async () => {
    await syncDotfiles();
});
