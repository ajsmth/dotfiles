import { spawn as spawnPty } from '@homebridge/node-pty-prebuilt-multiarch';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { stdin, stdout } from 'node:process';
import { run } from './process.js';
const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless');
const LOCAL_COMMANDS = [
    {
        command: 'pr submit',
        description: 'stage pending changes, then hand off to $git submit',
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
    { command: 'help', description: 'show local commands' },
];
function localCommand(commandName) {
    return LOCAL_COMMANDS.find((command) => command.command === commandName);
}
function commandHandoffPrompts(commandName) {
    return localCommand(commandName)?.handoff?.prompts ?? [];
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
function padRight(value, width) {
    const length = visibleLength(value);
    return length >= width ? value : `${value}${' '.repeat(width - length)}`;
}
function rgbParts(value) {
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}
function paletteCode(value, base) {
    if (value >= 0 && value <= 7) {
        return String(base + value);
    }
    if (value >= 8 && value <= 15) {
        return String(base + 60 + value - 8);
    }
    return `${base === 30 ? 38 : 48};5;${value}`;
}
function cellSgr(cell) {
    const codes = [];
    if (cell.isBold())
        codes.push('1');
    if (cell.isDim())
        codes.push('2');
    if (cell.isItalic())
        codes.push('3');
    if (cell.isUnderline())
        codes.push('4');
    if (cell.isBlink())
        codes.push('5');
    if (cell.isInverse())
        codes.push('7');
    if (cell.isStrikethrough())
        codes.push('9');
    if (cell.isOverline())
        codes.push('53');
    if (cell.isFgPalette()) {
        codes.push(paletteCode(cell.getFgColor(), 30));
    }
    else if (cell.isFgRGB()) {
        codes.push(`38;2;${rgbParts(cell.getFgColor()).join(';')}`);
    }
    if (cell.isBgPalette()) {
        codes.push(paletteCode(cell.getBgColor(), 40));
    }
    else if (cell.isBgRGB()) {
        codes.push(`48;2;${rgbParts(cell.getBgColor()).join(';')}`);
    }
    return codes.length === 0 ? '' : `\x1b[${codes.join(';')}m`;
}
function renderStyledLine(line, width) {
    if (!line) {
        return ' '.repeat(width);
    }
    const reusableCell = line.getCell(0);
    let output = '';
    let currentSgr = '';
    let used = 0;
    for (let column = 0; column < width; column += 1) {
        const cell = line.getCell(column, reusableCell);
        if (!cell) {
            output += ' ';
            used += 1;
            continue;
        }
        const cellWidth = cell.getWidth();
        if (cellWidth === 0) {
            continue;
        }
        const nextSgr = cellSgr(cell);
        if (nextSgr !== currentSgr) {
            output += nextSgr || '\x1b[0m';
            currentSgr = nextSgr;
        }
        const chars = cell.isInvisible() ? ' ' : cell.getChars() || ' ';
        output += chars;
        used += Math.max(cellWidth, 1);
    }
    if (currentSgr) {
        output += '\x1b[0m';
    }
    if (used < width) {
        output += ' '.repeat(width - used);
    }
    return output;
}
function git(args, cwd, allowFailure = false) {
    return run('git', args, { cwd, allowFailure });
}
function gitOutput(args, cwd) {
    return clean(git(args, cwd).stdout);
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
function compactPathList(values, limit = 3) {
    if (values.length === 0) {
        return 'none';
    }
    const visible = values.slice(0, limit).join(', ');
    const remaining = values.length - limit;
    return remaining > 0 ? `${visible}, +${remaining} more` : visible;
}
function formatMaybeEmpty(value) {
    return value.trim() || 'none';
}
function commandRemainder(commandLine, commandPattern) {
    return commandLine.replace(commandPattern, '').trim();
}
function commandSuggestion(commandBuffer) {
    if (commandBuffer.length === 0) {
        return '';
    }
    const match = LOCAL_COMMANDS.find((localCommand) => localCommand.command.startsWith(commandBuffer));
    if (!match || match.command === commandBuffer) {
        return '';
    }
    return match.command.slice(commandBuffer.length);
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
        throw new Error(`Unclosed ${quote} quote in local command.`);
    }
    if (escaping) {
        current += '\\';
    }
    if (current !== '') {
        words.push(current);
    }
    return words;
}
function prUpdatePrompt(context) {
    return [
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
    ].join('\n');
}
function prCheckPrompt(context) {
    return [
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
    ].join('\n');
}
function commandPath(name) {
    return `${process.env.HOME ?? ''}/.codex/skills/open-dif/scripts/${name}`;
}
function escapeSequenceEnd(value, start) {
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
}
class LlmHost {
    options;
    child;
    terminal;
    mode = 'child';
    commandBuffer = '';
    logicalLine = '';
    status = 'ready';
    confirmState = null;
    renderQueued = false;
    runningLocalCommand = false;
    scrollOffset = 0;
    screenActive = false;
    cols;
    rows;
    viewportRows;
    constructor(options) {
        this.options = options;
        this.cols = stdout.columns || 80;
        this.rows = stdout.rows || 24;
        this.viewportRows = this.childViewportRows();
        this.terminal = new Terminal({
            cols: this.cols,
            rows: this.viewportRows,
            allowProposedApi: true,
            scrollback: 2000,
        });
        this.child = spawnPty(options.command, options.args, {
            name: process.env.TERM || 'xterm-256color',
            cols: this.cols,
            rows: this.viewportRows,
            cwd: process.cwd(),
            env: process.env,
        });
    }
    async start() {
        if (!stdin.isTTY || !stdout.isTTY) {
            throw new Error('dev host requires an interactive TTY.');
        }
        this.enterScreen();
        this.attachInput();
        this.child.onData((data) => {
            this.terminal.write(data, () => this.queueRender());
        });
        this.child.onExit(({ exitCode }) => {
            this.exitScreen();
            process.exit(exitCode);
        });
        stdout.on('resize', () => this.resize());
        process.on('exit', () => this.exitScreen());
        process.on('SIGINT', () => {
            if (this.mode === 'child') {
                this.child.write('\u0003');
            }
            else {
                this.cancelCommandInput();
            }
        });
        this.render();
    }
    childViewportRows() {
        return Math.max(5, (stdout.rows || 24) - 2);
    }
    enterScreen() {
        this.screenActive = true;
        stdout.write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[2J');
    }
    exitScreen() {
        if (!this.screenActive) {
            return;
        }
        this.screenActive = false;
        if (stdin.isTTY) {
            stdin.setRawMode(false);
        }
        stdout.write('\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l');
    }
    attachInput() {
        stdin.setRawMode(true);
        stdin.resume();
        stdin.on('data', (chunk) => this.onInput(chunk));
    }
    resize() {
        this.cols = stdout.columns || 80;
        this.rows = stdout.rows || 24;
        this.viewportRows = this.childViewportRows();
        this.terminal.resize(this.cols, this.viewportRows);
        this.child.resize(this.cols, this.viewportRows);
        this.queueRender();
    }
    queueRender() {
        if (this.renderQueued) {
            return;
        }
        this.renderQueued = true;
        setTimeout(() => {
            this.renderQueued = false;
            this.render();
        }, 8);
    }
    render() {
        const buffer = this.terminal.buffer.active;
        const start = Math.max(0, buffer.baseY - this.scrollOffset);
        for (let row = 0; row < this.viewportRows; row += 1) {
            this.writeRow(row + 1, renderStyledLine(buffer.getLine(start + row), this.cols));
        }
        this.writeRow(this.viewportRows + 1, dim('─'.repeat(this.cols)));
        this.writeRow(this.viewportRows + 2, this.commandBar());
    }
    writeRow(row, content) {
        const safeContent = visibleLength(content) > this.cols
            ? truncatePlain(stripAnsi(content), this.cols)
            : content;
        stdout.write(`\x1b[${row};1H\x1b[2K${padRight(safeContent, this.cols)}`);
    }
    commandBar() {
        if (this.mode === 'command') {
            const prompt = `${blue('dev')} ${dim('>')} `;
            const suggestion = commandSuggestion(this.commandBuffer);
            return `${prompt}${this.commandBuffer}${dim(suggestion)}`;
        }
        if (this.mode === 'confirm' && this.confirmState) {
            const suffix = this.confirmState.defaultValue ? '[Y/n]' : '[y/N]';
            return `${cyan('?')} ${bold(this.confirmState.label)} ${dim(suffix)}`;
        }
        const scrollStatus = this.scrollOffset > 0 ? yellow(`scroll -${this.scrollOffset}`) : dim('bottom');
        const hint = `${blue('dev host')} ${dim(': for commands')}`;
        return `${hint} ${scrollStatus} ${dim(this.status)}`;
    }
    onInput(chunk) {
        const data = chunk.toString('utf8');
        for (let index = 0; index < data.length; index += 1) {
            const char = data[index];
            if (this.mode === 'confirm') {
                this.handleConfirmInput(char);
                return;
            }
            if (this.mode === 'command') {
                const shouldStop = this.handleCommandInput(data, index);
                this.queueRender();
                if (shouldStop) {
                    return;
                }
                continue;
            }
            if (char === '\u001b') {
                const end = escapeSequenceEnd(data, index);
                const sequence = data.slice(index, end);
                if (!this.handleHostEscape(sequence)) {
                    this.child.write(sequence);
                }
                index = end - 1;
                continue;
            }
            if (char === '\r' || char === '\n') {
                this.scrollToBottom();
                this.child.write(char);
                this.logicalLine = '';
                continue;
            }
            if (char === '\u0003') {
                this.child.write(char);
                this.logicalLine = '';
                continue;
            }
            if (char === '\u007f' || char === '\b') {
                this.child.write(char);
                this.logicalLine = this.logicalLine.slice(0, -1);
                continue;
            }
            if (char < ' ') {
                this.child.write(char);
                continue;
            }
            if (this.logicalLine.length === 0 && char === this.options.prefix) {
                this.mode = 'command';
                this.commandBuffer = '';
                this.status = 'local command mode';
                this.queueRender();
                continue;
            }
            this.child.write(char);
            if (this.scrollOffset > 0) {
                this.scrollToBottom();
            }
            this.logicalLine += char;
        }
    }
    handleCommandInput(data, index) {
        const char = data[index];
        if (char === '\u0003' || char === '\u0004') {
            this.cancelCommandInput();
            return true;
        }
        if (char === '\u001b') {
            this.cancelCommandInput();
            return true;
        }
        if (char === '\r' || char === '\n') {
            const commandLine = this.commandBuffer.trim();
            this.mode = 'child';
            this.commandBuffer = '';
            this.logicalLine = '';
            if (commandLine.length === 0) {
                this.status = 'command cancelled';
                return true;
            }
            this.status = `running :${commandLine}`;
            this.queueRender();
            void this.runLocalCommand(commandLine);
            return true;
        }
        if (char === '\u007f' || char === '\b') {
            this.commandBuffer = this.commandBuffer.slice(0, -1);
            return false;
        }
        if (char === '\t') {
            this.commandBuffer += commandSuggestion(this.commandBuffer);
            return false;
        }
        if (char < ' ') {
            return false;
        }
        this.commandBuffer += char;
        return false;
    }
    handleHostEscape(sequence) {
        if (sequence === '\x1b[5~') {
            this.scrollBy(this.viewportRows - 2);
            return true;
        }
        if (sequence === '\x1b[6~') {
            this.scrollBy(-(this.viewportRows - 2));
            return true;
        }
        if (sequence === '\x1b[H' || sequence === '\x1b[1~') {
            this.scrollToTop();
            return true;
        }
        if (sequence === '\x1b[F' || sequence === '\x1b[4~') {
            this.scrollToBottom();
            return true;
        }
        const mouseMatch = sequence.match(/^\x1b\[<(\d+);\d+;\d+M$/);
        if (mouseMatch) {
            const button = Number(mouseMatch[1]);
            if (button === 64) {
                this.scrollBy(3);
                return true;
            }
            if (button === 65) {
                this.scrollBy(-3);
                return true;
            }
        }
        return false;
    }
    maxScrollOffset() {
        const buffer = this.terminal.buffer.active;
        return Math.max(0, buffer.baseY);
    }
    scrollBy(delta) {
        this.scrollOffset = Math.max(0, Math.min(this.maxScrollOffset(), this.scrollOffset + delta));
        this.status = this.scrollOffset > 0 ? 'scrolling; End returns to bottom' : 'ready';
        this.queueRender();
    }
    scrollToTop() {
        this.scrollOffset = this.maxScrollOffset();
        this.status = 'top of scrollback';
        this.queueRender();
    }
    scrollToBottom() {
        this.scrollOffset = 0;
        this.status = 'ready';
        this.queueRender();
    }
    handleConfirmInput(char) {
        if (!this.confirmState) {
            return;
        }
        const state = this.confirmState;
        const finish = (value) => {
            this.confirmState = null;
            this.mode = 'child';
            this.status = value === 'cancel' ? 'cancelled' : `answered ${value ? 'yes' : 'no'}`;
            state.resolve(value);
            this.queueRender();
        };
        if (char === '\u0003' || char === '\u0004' || char === '\u001b') {
            finish('cancel');
            return;
        }
        if (char === '\r' || char === '\n') {
            finish(state.defaultValue);
            return;
        }
        const lowered = char.toLowerCase();
        if (lowered === 'y') {
            finish(true);
            return;
        }
        if (lowered === 'n') {
            finish(false);
        }
    }
    confirm(label, defaultValue) {
        this.mode = 'confirm';
        this.status = label;
        return new Promise((resolve) => {
            this.confirmState = { label, defaultValue, resolve };
            this.queueRender();
        });
    }
    async runLocalCommand(commandLine) {
        if (this.runningLocalCommand) {
            return;
        }
        this.runningLocalCommand = true;
        try {
            const words = parseWords(commandLine);
            if (words.length === 0) {
                return;
            }
            if (words[0] === 'help') {
                this.status = `commands: ${LOCAL_COMMANDS.map((command) => `:${command.command}`).join(', ')}`;
                return;
            }
            if (words[0] === 'pr' && (words[1] === 'submit' || words[1] === 'update')) {
                await this.runPrUpdate(commandRemainder(commandLine, /^pr\s+(?:submit|update)(?:\s+|$)/));
                return;
            }
            if (words[0] === 'pr' && words[1] === 'check') {
                this.runPrCheck(commandRemainder(commandLine, /^pr\s+check(?:\s+|$)/));
                return;
            }
            if (words[0] === 'diff') {
                this.runDiffCommand(words.slice(1));
                return;
            }
            this.status = `unknown command: ${words[0]}`;
        }
        catch (error) {
            this.status = error instanceof Error ? error.message : String(error);
        }
        finally {
            this.runningLocalCommand = false;
            this.mode = 'child';
            this.logicalLine = '';
            this.queueRender();
        }
    }
    async runPrUpdate(handoffNotes) {
        const repoRoot = gitOutput(['rev-parse', '--show-toplevel']);
        const branch = gitOutput(['branch', '--show-current'], repoRoot);
        if (!branch) {
            throw new Error('Current HEAD is detached. Check out a branch before using :pr submit.');
        }
        const statusBefore = gitOutput(['status', '--porcelain', '--untracked-files=all'], repoRoot);
        const entriesBefore = statusEntries(statusBefore);
        let stageAll = 'not-needed';
        this.status = [
            `${branch}`,
            `${green(`${entriesBefore.staged.length} staged`)}`,
            `${yellow(`${entriesBefore.unstaged.length} unstaged`)}`,
            `${magenta(`${entriesBefore.untracked.length} untracked`)}`,
            `staged: ${compactPathList(entriesBefore.staged)}`,
        ].join('  ');
        this.queueRender();
        if (hasUnstagedOrUntracked(statusBefore)) {
            const shouldStageAll = await this.confirm('Stage all unstaged and untracked changes?', true);
            if (shouldStageAll === 'cancel') {
                this.status = 'cancelled';
                return;
            }
            stageAll = shouldStageAll ? 'yes' : 'no';
            if (shouldStageAll) {
                git(['add', '-A'], repoRoot);
            }
        }
        const statusAfter = gitOutput(['status', '--porcelain', '--untracked-files=all'], repoRoot);
        const stagedFiles = git(['diff', '--cached', '--name-status'], repoRoot, true).stdout.trim();
        const unstagedFiles = git(['diff', '--name-status'], repoRoot, true).stdout.trim();
        const untrackedFiles = git(['ls-files', '--others', '--exclude-standard'], repoRoot, true).stdout.trim();
        const handoffDefault = hasStaged(statusAfter) || stageAll === 'yes';
        const handoffApproved = await this.confirm('Send this handoff to Codex as $git submit?', handoffDefault);
        if (handoffApproved === 'cancel' || !handoffApproved) {
            this.status = 'cancelled';
            return;
        }
        const pr = currentPr(repoRoot);
        const linearIssue = inferLinearIssue(branch);
        this.status = 'handoff sent';
        this.inject(prUpdatePrompt({
            branch,
            repoRoot,
            handoffNotes,
            statusBefore,
            statusAfter,
            stagedFiles,
            unstagedFiles: [unstagedFiles, untrackedFiles].filter(Boolean).join('\n'),
            stageAll,
            pr,
            linearIssue,
        }));
    }
    runPrCheck(handoffNotes) {
        const repoRoot = gitOutput(['rev-parse', '--show-toplevel']);
        const branch = gitOutput(['branch', '--show-current'], repoRoot);
        if (!branch) {
            throw new Error('Current HEAD is detached. Check out a branch before using :pr check.');
        }
        const pr = currentPr(repoRoot);
        const linearIssue = inferLinearIssue(branch);
        this.status = pr ? `checking PR #${pr.number}` : 'checking current PR';
        this.inject(prCheckPrompt({
            branch,
            repoRoot,
            handoffNotes,
            pr,
            linearIssue,
        }));
    }
    runDiffCommand(words) {
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
        this.exitScreen();
        spawnSync('bash', [script, ...args], {
            cwd: process.cwd(),
            env: process.env,
            stdio: 'inherit',
        });
        this.enterScreen();
        this.status = 'returned from diff';
    }
    cancelCommandInput() {
        this.mode = 'child';
        this.commandBuffer = '';
        this.logicalLine = '';
        this.status = 'command cancelled';
        this.queueRender();
    }
    inject(text) {
        this.scrollOffset = 0;
        const normalized = text.trimEnd();
        const chunks = [];
        if (this.options.bracketedPaste) {
            chunks.push('\x1b[200~');
            for (let index = 0; index < normalized.length; index += 128) {
                chunks.push(normalized.slice(index, index + 128));
            }
            chunks.push('\x1b[201~');
        }
        else {
            for (let index = 0; index < normalized.length; index += 128) {
                chunks.push(normalized.slice(index, index + 128));
            }
        }
        chunks.push('\r');
        const writeNext = () => {
            const chunk = chunks.shift();
            if (!chunk) {
                return;
            }
            this.child.write(chunk);
            setTimeout(writeNext, 1);
        };
        writeNext();
    }
}
export async function runLlmHost(options) {
    const host = new LlmHost(options);
    await host.start();
}
