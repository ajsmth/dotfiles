#!/usr/bin/env node
import { spawn as spawnPty } from '@homebridge/node-pty-prebuilt-multiarch';
import { cancel as clackCancel, confirm, intro, isCancel, note, outro } from '@clack/prompts';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { stdin, stdout } from 'node:process';
import { run } from '../lib/process.js';
function fail(message) {
    throw new Error(message);
}
function clean(value) {
    return value.trim();
}
function color(code, value) {
    return stdout.isTTY ? `\x1b[${code}m${value}\x1b[0m` : value;
}
function bold(value) {
    return color('1', value);
}
function dim(value) {
    return color('2', value);
}
function cyan(value) {
    return color('36', value);
}
function green(value) {
    return color('32', value);
}
function yellow(value) {
    return color('33', value);
}
function magenta(value) {
    return color('35', value);
}
function blue(value) {
    return color('34', value);
}
function stripAnsi(value) {
    return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}
function visibleLength(value) {
    return stripAnsi(value).length;
}
function truncatePlain(value, width) {
    if (value.length <= width) {
        return value;
    }
    if (width <= 1) {
        return value.slice(0, width);
    }
    return `${value.slice(0, width - 1)}...`;
}
function terminalWidth() {
    return Math.max(60, Math.min(stdout.columns || 88, 104));
}
function useClackPrompts() {
    return process.env.DEV_LLM_PROMPTS === 'clack';
}
const LOCAL_COMMANDS = [
    {
        command: 'pr submit',
        description: 'stage pending changes, then hand off to $git submit; trailing text becomes handoff notes',
        handoff: {
            prompts: ['$git submit', '$ticket'],
        },
    },
    {
        command: 'pr check',
        description: 'fetch PR comments with $git and address clear feedback',
        handoff: {
            prompts: ['$git comments', '$ticket'],
        },
    },
    { command: 'diff', description: 'open dif/revdiff through the diff skill helper' },
    { command: 'help', description: 'show this help' },
];
function localCommand(commandName) {
    return LOCAL_COMMANDS.find((command) => command.command === commandName);
}
function commandHandoffPrompts(commandName) {
    return localCommand(commandName)?.handoff?.prompts ?? [];
}
function defaultLogPath() {
    const stateHome = process.env.XDG_STATE_HOME ?? path.join(process.env.HOME ?? process.cwd(), '.local/state');
    return path.join(stateHome, 'dev', 'llm-wrapper.log');
}
function createLogger(logPath) {
    mkdirSync(path.dirname(logPath), { recursive: true });
    return {
        path: logPath,
        write(event, data = {}) {
            const entry = {
                ts: new Date().toISOString(),
                pid: process.pid,
                event,
                ...data,
            };
            appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
        },
    };
}
function git(args, cwd, allowFailure = false) {
    return run('git', args, { cwd, allowFailure });
}
function gitOutput(args, cwd) {
    return clean(git(args, cwd).stdout);
}
function parseWords(input) {
    const words = [];
    let current = '';
    let quote = null;
    let escaping = false;
    for (const char of input) {
        if (escaping) {
            current += char;
            escaping = false;
            continue;
        }
        if (char === '\\') {
            escaping = true;
            continue;
        }
        if (quote) {
            if (char === quote) {
                quote = null;
            }
            else {
                current += char;
            }
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (/\s/.test(char)) {
            if (current !== '') {
                words.push(current);
                current = '';
            }
            continue;
        }
        current += char;
    }
    if (quote) {
        fail(`Unclosed ${quote} quote in local command.`);
    }
    if (escaping) {
        current += '\\';
    }
    if (current !== '') {
        words.push(current);
    }
    return words;
}
function commandRemainder(commandLine, commandPattern) {
    return commandLine.replace(commandPattern, '').trim();
}
function parsePr(raw) {
    const value = JSON.parse(raw);
    if (typeof value.number !== 'number' || typeof value.url !== 'string') {
        return null;
    }
    return {
        number: value.number,
        title: typeof value.title === 'string' ? value.title : '',
        url: value.url,
    };
}
function currentPr(repoRoot) {
    const result = spawnSync('gh', ['pr', 'view', '--json', 'number,title,url'], {
        cwd: repoRoot,
        env: process.env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 3000,
    });
    if (result.error || result.status !== 0 || typeof result.stdout !== 'string' || result.stdout.trim() === '') {
        return null;
    }
    return parsePr(result.stdout);
}
function inferLinearIssue(branch) {
    return branch.match(/[A-Z][A-Z0-9]+-\d+/)?.[0] ?? null;
}
function hasUnstagedOrUntracked(status) {
    return status
        .split('\n')
        .filter(Boolean)
        .some((line) => line.startsWith('??') || line[1] !== ' ');
}
function hasStaged(status) {
    return status
        .split('\n')
        .filter(Boolean)
        .some((line) => !line.startsWith('??') && line[0] !== ' ');
}
function statusEntries(status) {
    const staged = [];
    const unstaged = [];
    const untracked = [];
    for (const line of status.split('\n').filter(Boolean)) {
        const pathspec = line.slice(2).trimStart();
        if (line.startsWith('??')) {
            untracked.push(pathspec);
            continue;
        }
        if (line[0] !== ' ') {
            staged.push(`${line[0]} ${pathspec}`);
        }
        if (line[1] !== ' ') {
            unstaged.push(`${line[1]} ${pathspec}`);
        }
    }
    return { staged, unstaged, untracked };
}
async function promptYesNo(label, defaultValue) {
    if (useClackPrompts()) {
        const answer = await confirm({
            message: label,
            initialValue: defaultValue,
            input: stdin,
            output: stdout,
        });
        return isCancel(answer) ? 'cancel' : answer;
    }
    return promptYesNoRaw(label, defaultValue);
}
async function promptYesNoRaw(label, defaultValue) {
    const suffix = defaultValue ? ' [Y/n]' : ' [y/N]';
    const prompt = `${cyan('?')} ${bold(label)}${dim(`${suffix}: `)}`;
    try {
        while (true) {
            stdout.write(prompt);
            const answer = await readPromptKey();
            stdout.write('\n');
            if (answer === 'enter')
                return defaultValue;
            if (answer === 'yes')
                return true;
            if (answer === 'no')
                return false;
            if (answer === 'abort')
                return 'cancel';
            console.log(yellow('Please press y or n.'));
        }
    }
    finally {
        stdin.pause();
    }
}
function readPromptKey() {
    return new Promise((resolve) => {
        const previousRawMode = stdin.isRaw;
        const cleanup = () => {
            stdin.off('data', onData);
            if (stdin.isTTY) {
                stdin.setRawMode(previousRawMode);
            }
        };
        const onData = (chunk) => {
            const value = chunk.toString('utf8');
            const char = value[0];
            cleanup();
            if (char === '\u0003') {
                stdout.write('^C');
                resolve('abort');
                return;
            }
            if (char === '\r' || char === '\n') {
                resolve('enter');
                return;
            }
            const lowered = char.toLowerCase();
            if (lowered === 'y') {
                stdout.write('y');
                resolve('yes');
                return;
            }
            if (lowered === 'n') {
                stdout.write('n');
                resolve('no');
                return;
            }
            resolve('other');
        };
        if (stdin.isTTY) {
            stdin.setRawMode(true);
        }
        stdin.resume();
        stdin.on('data', onData);
    });
}
function formatMaybeEmpty(value) {
    return value.trim() || 'none';
}
function compactPathList(values, limit = 4) {
    if (values.length === 0) {
        return dim('none');
    }
    const visible = values.slice(0, limit).join(', ');
    const remaining = values.length - limit;
    return remaining > 0 ? `${visible}, ${dim(`+${remaining} more`)}` : visible;
}
function statusBadge(status) {
    return status.trim() ? yellow('changes found') : green('clean');
}
function prUpdatePreflightMessage(repoRoot, branch, status) {
    const entries = statusEntries(status);
    const repoDisplay = repoRoot.replace(`${process.env.HOME ?? ''}`, '~');
    const width = terminalWidth();
    const labelWidth = 10;
    const valueWidth = Math.max(24, width - labelWidth - 3);
    const row = (label, value) => {
        const safeValue = visibleLength(value) > valueWidth
            ? truncatePlain(stripAnsi(value), valueWidth)
            : value;
        return `${dim(label.padEnd(labelWidth, ' '))} ${safeValue}`;
    };
    return [
        row('repo', repoDisplay),
        row('branch', branch),
        row('state', statusBadge(status)),
        `${dim('changes'.padEnd(labelWidth, ' '))} ${green(`${entries.staged.length} staged`)} ${dim('/')} ${yellow(`${entries.unstaged.length} unstaged`)} ${dim('/')} ${magenta(`${entries.untracked.length} untracked`)}`,
        '',
        row('staged', compactPathList(entries.staged)),
        row('unstaged', compactPathList(entries.unstaged)),
        row('untracked', compactPathList(entries.untracked)),
    ].join('\n');
}
function printPrUpdatePreflight(repoRoot, branch, status, title = 'Working tree') {
    if (useClackPrompts()) {
        note(prUpdatePreflightMessage(repoRoot, branch, status), title, {
            output: stdout,
        });
        return;
    }
    console.log('');
    console.log(`${blue('dev')} ${dim('/')} ${bold('pr submit')}`);
    console.log(prUpdatePreflightMessage(repoRoot, branch, status));
    console.log('');
}
function printCancel(message = 'Cancelled. Nothing was sent to Codex.') {
    if (useClackPrompts()) {
        clackCancel(message, { output: stdout });
        return;
    }
    console.log(dim(message));
}
function commandCancelledPrompt(commandName) {
    return [
        `Local command :${commandName} was cancelled by the user.`,
        'Do not take any git, GitHub, or Linear action for that command.',
        'Acknowledge the cancellation briefly and wait for the next instruction.',
    ].join('\n');
}
function commandInputCancelledPrompt() {
    return [
        'Local command entry was cancelled by the user.',
        'Do not take any action for that command.',
        'Acknowledge the cancellation briefly and wait for the next instruction.',
    ].join('\n');
}
function prUpdatePrompt(context) {
    const lines = [
        ...commandHandoffPrompts('pr submit'),
        '',
        'Context from :pr submit:',
        `- repo: ${context.repoRoot}`,
        `- branch: ${context.branch}`,
        `- user chose to stage all: ${context.stageAll}`,
        '- user approved handoff to Codex: yes',
        context.pr
            ? `- current PR: #${context.pr.number} ${context.pr.title} (${context.pr.url})`
            : '- current PR: none found',
        context.linearIssue
            ? `- possible Linear ticket: ${context.linearIssue}`
            : '- possible Linear ticket: none inferred',
        context.handoffNotes
            ? `- user handoff notes: ${context.handoffNotes}`
            : '- user handoff notes: none provided',
        '',
        'Staged files:',
        formatMaybeEmpty(context.stagedFiles),
        '',
        'Unstaged/untracked files:',
        formatMaybeEmpty(context.unstagedFiles),
        '',
        'Use Andrew\'s git rules to inspect the changes, create a conventional commit if needed, push the branch, and create or update the PR.',
        'If a Linear ticket is associated with this work, use Andrew\'s ticket workflow conservatively: update status toward review/PR when appropriate, add a concise important update comment only when useful, and include the ticket URL in the final response.',
    ];
    return lines.join('\n');
}
function prCheckPrompt(context) {
    const lines = [
        ...commandHandoffPrompts('pr check'),
        '',
        'Context from :pr check:',
        `- repo: ${context.repoRoot}`,
        `- branch: ${context.branch}`,
        context.pr
            ? `- current PR: #${context.pr.number} ${context.pr.title} (${context.pr.url})`
            : '- current PR: none found locally; use gh to resolve the current PR if possible',
        context.linearIssue
            ? `- possible Linear ticket: ${context.linearIssue}`
            : '- possible Linear ticket: none inferred',
        context.handoffNotes
            ? `- user handoff notes: ${context.handoffNotes}`
            : '- user handoff notes: none provided',
        '',
        'Use Andrew\'s git comments workflow:',
        '- Fetch current PR issue comments, inline review comments, and submitted reviews with gh.',
        '- Determine which feedback is relevant and actionable.',
        '- Watch for repeated feedback patterns; if similar issues keep recurring, change strategy instead of applying another isolated fix.',
        '- If there is confusion, ambiguity, suspect behavior, unclear product intent, or reviewer preference, pause and ask the user how to proceed.',
        '- Otherwise inspect the code, make the relevant changes, run focused checks when practical, commit with conventional commit syntax, push, update the PR if significant, and include the PR URL in the final response.',
        '- After the PR is resubmitted or confirmed current, use Andrew\'s ticket workflow if a ticket is associated: update status/comment only when appropriate and include the ticket URL in the final response.',
    ];
    return lines.join('\n');
}
function runPrCheck(handoffNotes) {
    const repoRoot = gitOutput(['rev-parse', '--show-toplevel']);
    const branch = gitOutput(['branch', '--show-current'], repoRoot);
    if (!branch) {
        fail('Current HEAD is detached. Check out a branch before using :pr check.');
    }
    const pr = currentPr(repoRoot);
    const linearIssue = inferLinearIssue(branch);
    return {
        inject: prCheckPrompt({
            branch,
            repoRoot,
            handoffNotes,
            pr,
            linearIssue,
        }),
    };
}
async function runPrUpdate(handoffNotes) {
    const repoRoot = gitOutput(['rev-parse', '--show-toplevel']);
    const branch = gitOutput(['branch', '--show-current'], repoRoot);
    if (!branch) {
        fail('Current HEAD is detached. Check out a branch before using :pr submit.');
    }
    const statusBefore = gitOutput(['status', '--porcelain', '--untracked-files=all'], repoRoot);
    let stageAll = 'not-needed';
    if (useClackPrompts()) {
        intro('dev / pr submit', { output: stdout });
    }
    printPrUpdatePreflight(repoRoot, branch, statusBefore);
    if (hasUnstagedOrUntracked(statusBefore)) {
        const shouldStageAll = await promptYesNo('Stage all unstaged and untracked changes?', true);
        if (shouldStageAll === 'cancel') {
            printCancel();
            return { inject: commandCancelledPrompt('pr submit') };
        }
        stageAll = shouldStageAll ? 'yes' : 'no';
        if (shouldStageAll) {
            git(['add', '-A'], repoRoot);
        }
    }
    const statusAfter = gitOutput(['status', '--porcelain', '--untracked-files=all'], repoRoot);
    if (statusAfter !== statusBefore) {
        printPrUpdatePreflight(repoRoot, branch, statusAfter, 'Updated working tree');
    }
    const stagedFiles = git(['diff', '--cached', '--name-status'], repoRoot, true).stdout.trim();
    const unstagedFiles = git(['diff', '--name-status'], repoRoot, true).stdout.trim();
    const untrackedFiles = git(['ls-files', '--others', '--exclude-standard'], repoRoot, true).stdout.trim();
    const handoffDefault = hasStaged(statusAfter) || stageAll === 'yes';
    const handoffApproved = await promptYesNo('Send this handoff to Codex as $git submit?', handoffDefault);
    if (handoffApproved === 'cancel' || !handoffApproved) {
        printCancel();
        return { inject: commandCancelledPrompt('pr submit') };
    }
    const pr = currentPr(repoRoot);
    const linearIssue = inferLinearIssue(branch);
    if (useClackPrompts()) {
        outro('Sending handoff to Codex.', { output: stdout });
    }
    return {
        inject: prUpdatePrompt({
            branch,
            repoRoot,
            handoffNotes,
            statusBefore,
            statusAfter,
            stagedFiles,
            unstagedFiles: [unstagedFiles, untrackedFiles].filter(Boolean).join('\n'),
            stageAll,
            submitRequested: true,
            pr,
            linearIssue,
        }),
    };
}
function commandPath(name) {
    return `${process.env.HOME ?? ''}/.codex/skills/open-dif/scripts/${name}`;
}
function runDiffCommand(words) {
    const script = commandPath('open-dif.sh');
    const args = [];
    const joined = words.join(' ').toLowerCase();
    if (joined.includes('last message') || joined === 'message') {
        args.push('--message', process.cwd());
    }
    else {
        const againstIndex = words.indexOf('against');
        if (againstIndex !== -1 && words[againstIndex + 1]) {
            args.push('--against', words[againstIndex + 1], process.cwd());
        }
        else {
            args.push(process.cwd());
            if (words.length > 0) {
                args.push('--', ...words);
            }
        }
    }
    spawnSync('bash', [script, ...args], {
        cwd: process.cwd(),
        env: process.env,
        stdio: 'inherit',
    });
    return {};
}
async function runLocalCommand(commandLine) {
    const words = parseWords(commandLine);
    if (words.length === 0) {
        return {};
    }
    if (words[0] === 'help') {
        console.log('');
        console.log('Local commands:');
        for (const localCommand of LOCAL_COMMANDS) {
            console.log(`  :${localCommand.command.padEnd(16, ' ')} ${localCommand.description}`);
        }
        return {};
    }
    if (words[0] === 'pr' && (words[1] === 'submit' || words[1] === 'update')) {
        return runPrUpdate(commandRemainder(commandLine, /^pr\s+(?:submit|update)(?:\s+|$)/));
    }
    if (words[0] === 'pr' && words[1] === 'check') {
        return runPrCheck(commandRemainder(commandLine, /^pr\s+check(?:\s+|$)/));
    }
    if (words[0] === 'diff') {
        return runDiffCommand(words.slice(1));
    }
    console.log(`Unknown local command: ${words[0]}`);
    console.log('Run :help for available commands.');
    return {};
}
function inject(pty, text, bracketedPaste) {
    const normalized = text.trimEnd();
    const writeChunks = (value) => {
        for (let index = 0; index < value.length; index += 256) {
            pty.write(value.slice(index, index + 256));
        }
    };
    if (bracketedPaste) {
        pty.write('\x1b[200~');
        writeChunks(normalized);
        pty.write('\x1b[201~');
    }
    else {
        writeChunks(normalized);
    }
    pty.write('\r');
}
async function runLlmWrapper(options) {
    const logger = createLogger(options.logPath);
    logger.write('wrapper_start', {
        command: options.command,
        argsCount: options.args.length,
        prefix: options.prefix,
        bracketedPaste: options.bracketedPaste,
        cwd: process.cwd(),
        term: process.env.TERM ?? null,
        logPath: logger.path,
    });
    if (options.prefix.length !== 1) {
        logger.write('wrapper_error', { message: 'prefix length was not one character' });
        fail('DEV_LLM_PREFIX must be a single character.');
    }
    if (!stdin.isTTY || !stdout.isTTY) {
        logger.write('wrapper_error', { message: 'stdin/stdout was not a TTY' });
        fail('dev llm requires an interactive TTY.');
    }
    const child = spawnPty(options.command, options.args, {
        name: process.env.TERM || 'xterm-256color',
        cols: stdout.columns || 80,
        rows: stdout.rows || 24,
        cwd: process.cwd(),
        env: process.env,
    });
    logger.write('child_spawned', {
        childPid: child.pid,
        cols: stdout.columns || 80,
        rows: stdout.rows || 24,
    });
    let capturing = false;
    let commandBuffer = '';
    let logicalLine = '';
    let runningLocalCommand = false;
    const commandSuggestion = () => {
        if (commandBuffer.length === 0) {
            return '';
        }
        const match = LOCAL_COMMANDS.find((localCommand) => localCommand.command.startsWith(commandBuffer));
        if (!match || match.command === commandBuffer) {
            return '';
        }
        return match.command.slice(commandBuffer.length);
    };
    const renderCommandPrompt = () => {
        const prompt = `${blue('dev')} ${dim('>')} `;
        const suggestion = commandSuggestion();
        stdout.write('\r\x1b[2K');
        stdout.write(`${prompt}${commandBuffer}`);
        if (suggestion) {
            stdout.write(dim(suggestion));
            stdout.write(`\x1b[${visibleLength(suggestion)}D`);
        }
    };
    const clearCommandPrompt = () => {
        stdout.write('\r\x1b[2K');
    };
    const restoreTerminal = () => {
        if (stdin.isTTY) {
            stdin.setRawMode(false);
        }
        logger.write('terminal_restore');
    };
    const detachInput = () => {
        stdin.off('data', onInput);
        logger.write('input_detached');
    };
    const attachInput = () => {
        stdin.off('data', onInput);
        if (stdin.isTTY) {
            stdin.setRawMode(true);
        }
        stdin.resume();
        stdin.on('data', onInput);
        logger.write('input_attached', {
            rawMode: stdin.isTTY,
            readableFlowing: stdin.readableFlowing,
        });
    };
    const runCapturedCommand = async (commandLine) => {
        runningLocalCommand = true;
        detachInput();
        restoreTerminal();
        logger.write('local_command_start', { commandLine });
        let result = null;
        try {
            result = await runLocalCommand(commandLine);
            if (result.inject) {
                logger.write('local_command_inject', {
                    commandLine,
                    bytes: Buffer.byteLength(result.inject, 'utf8'),
                });
            }
            else {
                logger.write('local_command_no_inject', { commandLine });
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.write('local_command_error', { commandLine, message });
            console.error(`Local command failed: ${message}`);
        }
        finally {
            runningLocalCommand = false;
            logicalLine = '';
            attachInput();
            if (result?.inject) {
                inject(child, result.inject, options.bracketedPaste);
            }
            logger.write('local_command_end', { commandLine });
        }
    };
    const cancelCommandInput = () => {
        clearCommandPrompt();
        stdout.write(`${dim('dev command cancelled')}\r\n`);
        capturing = false;
        commandBuffer = '';
        logicalLine = '';
        logger.write('local_command_cancelled');
        inject(child, commandInputCancelledPrompt(), options.bracketedPaste);
    };
    const atLogicalLineStart = () => logicalLine.length === 0;
    const escapeSequenceEnd = (value, start) => {
        const next = value[start + 1];
        if (!next) {
            return start + 1;
        }
        if (next === '[') {
            for (let index = start + 2; index < value.length; index += 1) {
                const code = value.charCodeAt(index);
                if (code >= 0x40 && code <= 0x7e) {
                    return index + 1;
                }
            }
            return value.length;
        }
        if (next === ']') {
            for (let index = start + 2; index < value.length; index += 1) {
                if (value[index] === '\u0007') {
                    return index + 1;
                }
                if (value[index] === '\u001b' && value[index + 1] === '\\') {
                    return index + 2;
                }
            }
            return value.length;
        }
        return Math.min(start + 2, value.length);
    };
    const onInput = (chunk) => {
        if (runningLocalCommand) {
            logger.write('input_ignored_local_running', { bytes: chunk.length });
            return;
        }
        const data = chunk.toString('utf8');
        logger.write('input_chunk', {
            bytes: chunk.length,
            chars: Array.from(data).length,
            capturing,
            atLineStart: atLogicalLineStart(),
            logicalLineLength: logicalLine.length,
        });
        for (let index = 0; index < data.length; index += 1) {
            const char = data[index];
            if (capturing) {
                if (char === '\u0003' || char === '\u0004') {
                    cancelCommandInput();
                    return;
                }
                if (char === '\u001b') {
                    const end = escapeSequenceEnd(data, index);
                    cancelCommandInput();
                    index = end - 1;
                    return;
                }
                if (char === '\r' || char === '\n') {
                    const commandLine = commandBuffer.trim();
                    clearCommandPrompt();
                    capturing = false;
                    commandBuffer = '';
                    logicalLine = '';
                    logger.write('local_command_submit', { commandLine });
                    if (commandLine.length === 0) {
                        stdout.write(`${dim('dev command empty')}\r\n`);
                        inject(child, commandInputCancelledPrompt(), options.bracketedPaste);
                        return;
                    }
                    stdout.write(`${blue('dev')} ${dim('/')} ${commandLine}\r\n`);
                    void runCapturedCommand(commandLine);
                    return;
                }
                if (char === '\u007f' || char === '\b') {
                    if (commandBuffer.length > 0) {
                        commandBuffer = commandBuffer.slice(0, -1);
                        renderCommandPrompt();
                    }
                    continue;
                }
                if (char === '\t') {
                    commandBuffer += commandSuggestion();
                    renderCommandPrompt();
                    continue;
                }
                if (char < ' ') {
                    logger.write('capture_control_ignored', { code: char.charCodeAt(0) });
                    continue;
                }
                commandBuffer += char;
                renderCommandPrompt();
                continue;
            }
            if (char === '\u001b') {
                const end = escapeSequenceEnd(data, index);
                const sequence = data.slice(index, end);
                child.write(sequence);
                logger.write('escape_forwarded', {
                    bytes: Buffer.byteLength(sequence, 'utf8'),
                    logicalLineLength: logicalLine.length,
                });
                index = end - 1;
                continue;
            }
            if (char === '\r' || char === '\n') {
                child.write(char);
                logicalLine = '';
                continue;
            }
            if (char === '\u0003') {
                child.write(char);
                logicalLine = '';
                continue;
            }
            if (char === '\u007f' || char === '\b') {
                child.write(char);
                logicalLine = logicalLine.slice(0, -1);
                continue;
            }
            if (char < ' ') {
                child.write(char);
                logger.write('control_forwarded', {
                    code: char.charCodeAt(0),
                    logicalLineLength: logicalLine.length,
                });
                continue;
            }
            if (char === options.prefix) {
                logger.write('prefix_seen', {
                    atLineStart: atLogicalLineStart(),
                    capturing,
                    logicalLineLength: logicalLine.length,
                });
            }
            if (atLogicalLineStart() && char === options.prefix) {
                capturing = true;
                commandBuffer = '';
                renderCommandPrompt();
                logger.write('prefix_intercepted');
                continue;
            }
            child.write(char);
            if (char === options.prefix) {
                logger.write('prefix_forwarded_to_child', {
                    atLineStart: atLogicalLineStart(),
                    logicalLineLength: logicalLine.length,
                });
            }
            logicalLine += char;
        }
    };
    child.onData((data) => {
        stdout.write(data);
    });
    child.onExit(({ exitCode }) => {
        logger.write('child_exit', { exitCode });
        restoreTerminal();
        process.exit(exitCode);
    });
    process.on('SIGINT', () => {
        logger.write('sigint_forwarded');
        child.write('\u0003');
    });
    process.on('exit', restoreTerminal);
    stdout.on('resize', () => {
        logger.write('resize', {
            cols: stdout.columns || 80,
            rows: stdout.rows || 24,
        });
        child.resize(stdout.columns || 80, stdout.rows || 24);
    });
    attachInput();
    logger.write('wrapper_ready');
}
const [command, ...args] = process.argv.slice(2);
if (!command) {
    fail('Usage: llm-wrapper.ts <native-cli> [args...]');
}
await runLlmWrapper({
    command,
    args,
    prefix: process.env.DEV_LLM_PREFIX ?? ':',
    bracketedPaste: process.env.DEV_LLM_BRACKETED_PASTE !== '0',
    logPath: process.env.DEV_LLM_LOG ?? defaultLogPath(),
});
