import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { run } from './process.js';
import { printKeyValue, printSection, step } from './ui.js';
function findDotfilesRoot() {
    const currentFile = fileURLToPath(import.meta.url);
    const binRoot = path.resolve(path.dirname(currentFile), '..', '..');
    const binRootCheck = run('test', ['-x', path.join(binRoot, 'scripts', 'dotfiles.sh')], {
        allowFailure: true,
    });
    if (binRootCheck.status === 0) {
        return binRoot;
    }
    const cwdCheck = run('git', ['rev-parse', '--show-toplevel'], {
        allowFailure: true,
    });
    const cwdRoot = cwdCheck.stdout.trim();
    if (cwdCheck.status === 0 && cwdRoot) {
        const scriptCheck = run('test', ['-x', path.join(cwdRoot, 'scripts', 'dotfiles.sh')], {
            allowFailure: true,
        });
        if (scriptCheck.status === 0) {
            return cwdRoot;
        }
    }
    throw new Error('Could not locate dotfiles root with scripts/dotfiles.sh.');
}
export async function syncDotfiles() {
    const root = findDotfilesRoot();
    await step('Restowing dotfiles', async () => {
        run('./scripts/dotfiles.sh', ['restow', '.'], {
            cwd: root,
            stdio: 'inherit',
        });
    });
    console.log('');
    printSection('Dotfiles Synced');
    printKeyValue('Root', root);
}
