import { spawn as spawnPty } from '@homebridge/node-pty-prebuilt-multiarch';
import { tsImport } from 'tsx/esm/api';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { stdin, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';
import { HostCommandRegistry, commandSuggestion, parseWords, } from './host-commands.js';
const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless');
const SELECTION_FG = '38;2;35;40;49';
const SELECTION_BG = '48;2;235;203;139';
const RENDER_INTERVAL_MS = 16;
const WHEEL_FLUSH_MS = 16;
const LOADING_INTERVAL_MS = 120;
const LOADING_FRAMES = ['-', '\\', '|', '/'];
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
const HOST_LOG_PATH = `${process.env.HOME ?? process.cwd()}/.local/state/dev/llm-host.log`;
const HOST_COMMANDS_DIR = process.env.DEV_HOST_COMMANDS_DIR
    ?? `${process.env.HOME ?? process.cwd()}/.config/dev/commands`;
const DEFAULT_MODAL_THEME = {
    panelBg: '#2e3440',
    panelFg: '#cdcecf',
    selectedBg: '#3e4a5b',
    selectedFg: '#cdcecf',
    border: '#5a657d',
    accent: '#a3be8c',
    muted: '#7e8188',
    shadow: '#232831',
};
function readJsonFile(pathname) {
    return JSON.parse(readFileSync(pathname, 'utf8'));
}
function objectRecord(value) {
    return value && typeof value === 'object' ? value : null;
}
function stringField(record, key) {
    const value = record[key];
    return typeof value === 'string' ? value : null;
}
function loadModalTheme() {
    const home = process.env.HOME;
    if (!home) {
        return DEFAULT_MODAL_THEME;
    }
    try {
        const settings = objectRecord(readJsonFile(`${home}/.pi/agent/settings.json`));
        const themeName = settings ? stringField(settings, 'theme') ?? 'nordfox' : 'nordfox';
        const theme = objectRecord(readJsonFile(`${home}/.pi/agent/themes/${themeName}.json`));
        const palette = theme ? objectRecord(theme.palette) : null;
        if (!palette) {
            return DEFAULT_MODAL_THEME;
        }
        return {
            panelBg: stringField(palette, 'bg') ?? DEFAULT_MODAL_THEME.panelBg,
            panelFg: stringField(palette, 'fg') ?? DEFAULT_MODAL_THEME.panelFg,
            selectedBg: stringField(palette, 'bgSelect') ?? DEFAULT_MODAL_THEME.selectedBg,
            selectedFg: stringField(palette, 'fg') ?? DEFAULT_MODAL_THEME.selectedFg,
            border: stringField(palette, 'border') ?? DEFAULT_MODAL_THEME.border,
            accent: stringField(palette, 'green') ?? DEFAULT_MODAL_THEME.accent,
            muted: stringField(palette, 'muted') ?? DEFAULT_MODAL_THEME.muted,
            shadow: stringField(palette, 'bg0') ?? DEFAULT_MODAL_THEME.shadow,
        };
    }
    catch {
        return DEFAULT_MODAL_THEME;
    }
}
const MODAL_THEME = loadModalTheme();
function logHostEvent(event, details = {}) {
    try {
        mkdirSync(`${process.env.HOME ?? process.cwd()}/.local/state/dev`, { recursive: true });
        appendFileSync(HOST_LOG_PATH, `${JSON.stringify({
            time: new Date().toISOString(),
            event,
            ...details,
        })}\n`);
    }
    catch {
        // Logging must never interfere with the terminal host.
    }
}
function isMissingDirectory(error) {
    return error instanceof Error
        && 'code' in error
        && error.code === 'ENOENT';
}
function normalizeCommandText(value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function normalizeSearchText(value) {
    return value.toLowerCase().trim();
}
function filterModalItems(items, searchText) {
    if (!searchText) {
        return items;
    }
    const query = normalizeSearchText(searchText);
    return items.filter((item) => {
        const title = normalizeSearchText(item.title);
        const subtitle = normalizeSearchText(item.subtitle ?? '');
        const value = normalizeSearchText(item.value ?? '');
        return title.includes(query) || subtitle.includes(query) || value.includes(query);
    });
}
function commandSearchScore(command, term) {
    const query = normalizeCommandText(term);
    if (!query) {
        return 1;
    }
    const names = [command.command, ...(command.aliases ?? [])];
    const normalizedNames = names.map(normalizeCommandText);
    const haystack = normalizeCommandText(`${names.join(' ')} ${command.description}`);
    const tokens = query.split(/\s+/).filter(Boolean);
    let score = 0;
    if (normalizedNames.some((name) => name === query))
        score += 200;
    if (normalizedNames.some((name) => name.startsWith(query)))
        score += 120;
    if (normalizedNames.some((name) => name.includes(query)))
        score += 90;
    if (haystack.includes(query))
        score += 60;
    if (tokens.length > 0 && tokens.every((token) => haystack.includes(token))) {
        score += tokens.length * 25;
    }
    return score;
}
function commandModuleRegister(module) {
    if (!module || typeof module !== 'object') {
        return null;
    }
    const record = module;
    if (typeof record.register === 'function') {
        return record.register;
    }
    if (typeof record.default === 'function') {
        return record.default;
    }
    if (record.default && typeof record.default === 'object') {
        const defaultRecord = record.default;
        if (typeof defaultRecord.register === 'function') {
            return defaultRecord.register;
        }
    }
    return null;
}
function color(code, value) {
    return stdout.isTTY ? `\x1b[${code}m${value}\x1b[0m` : value;
}
function hexToRgb(value) {
    const match = value.match(/^#?([0-9a-f]{6})$/i);
    if (!match) {
        return null;
    }
    const raw = Number.parseInt(match[1], 16);
    return [(raw >> 16) & 255, (raw >> 8) & 255, raw & 255];
}
function trueColor(kind, value) {
    const rgb = hexToRgb(value);
    return rgb ? `${kind};2;${rgb.join(';')}` : `${kind === 38 ? 37 : 40}`;
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
function yellow(value) {
    return color('33', value);
}
function blue(value) {
    return color('34', value);
}
function modalAccent(value) {
    return color(trueColor(38, MODAL_THEME.accent), value);
}
function modalBorderColor(value) {
    return color(trueColor(38, MODAL_THEME.border), value);
}
function modalMuted(value) {
    return color(trueColor(38, MODAL_THEME.muted), value);
}
function modalPanel(value) {
    return color(`${trueColor(48, MODAL_THEME.panelBg)};${trueColor(38, MODAL_THEME.panelFg)}`, value);
}
function modalPanelSelected(value) {
    return color(`${trueColor(48, MODAL_THEME.selectedBg)};${trueColor(38, MODAL_THEME.selectedFg)}`, value);
}
function modalShadow(value) {
    return color(`${trueColor(48, MODAL_THEME.shadow)};${trueColor(38, MODAL_THEME.shadow)}`, value);
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
function centerText(value, width) {
    const text = truncatePlain(value, width);
    const left = Math.floor(Math.max(0, width - visibleLength(text)) / 2);
    return padRight(`${' '.repeat(left)}${text}`, width);
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
function cellSgr(cell, selected = false) {
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
    if (cell.isInverse() && !selected)
        codes.push('7');
    if (cell.isStrikethrough())
        codes.push('9');
    if (cell.isOverline())
        codes.push('53');
    if (selected) {
        codes.push(SELECTION_FG, SELECTION_BG);
    }
    else if (cell.isFgPalette()) {
        codes.push(paletteCode(cell.getFgColor(), 30));
    }
    else if (cell.isFgRGB()) {
        codes.push(`38;2;${rgbParts(cell.getFgColor()).join(';')}`);
    }
    if (!selected) {
        if (cell.isBgPalette()) {
            codes.push(paletteCode(cell.getBgColor(), 40));
        }
        else if (cell.isBgRGB()) {
            codes.push(`48;2;${rgbParts(cell.getBgColor()).join(';')}`);
        }
    }
    return codes.length === 0 ? '' : `\x1b[${codes.join(';')}m`;
}
function renderStyledLine(line, width, selectedColumn = () => false) {
    if (!line) {
        let output = '';
        let selected = false;
        for (let column = 0; column < width; column += 1) {
            const nextSelected = selectedColumn(column);
            if (nextSelected !== selected) {
                output += nextSelected ? `\x1b[${SELECTION_FG};${SELECTION_BG}m` : '\x1b[0m';
                selected = nextSelected;
            }
            output += ' ';
        }
        return selected ? `${output}\x1b[0m` : output;
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
        const nextSgr = cellSgr(cell, selectedColumn(column));
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
function selectionBounds(selection) {
    const { anchor, focus } = selection;
    if (anchor.row < focus.row || (anchor.row === focus.row && anchor.column <= focus.column)) {
        return { start: anchor, end: focus };
    }
    return { start: focus, end: anchor };
}
function isPointSelected(selection, point) {
    if (!selection) {
        return false;
    }
    const { start, end } = selectionBounds(selection);
    if (point.row < start.row || point.row > end.row) {
        return false;
    }
    if (start.row === end.row) {
        return point.column >= start.column && point.column <= end.column;
    }
    if (point.row === start.row) {
        return point.column >= start.column;
    }
    if (point.row === end.row) {
        return point.column <= end.column;
    }
    return true;
}
function parseMouseEvent(sequence) {
    const match = sequence.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
    if (!match) {
        return null;
    }
    return {
        button: Number(match[1]),
        column: Number(match[2]),
        row: Number(match[3]),
        released: match[4] === 'm',
    };
}
function escapeSequenceEnd(value, start) {
    const next = value[start + 1];
    if (!next) {
        return start + 1;
    }
    if (next === '[') {
        for (let index = start + 2; index < value.length; index += 1) {
            const code = value.charCodeAt(index);
            if (value[start + 2] === '<' && (value[index] === 'M' || value[index] === 'm')) {
                return index + 1;
            }
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
function isIncompleteEscapeSequence(value, start, end) {
    if (end < value.length) {
        return false;
    }
    const next = value[start + 1];
    if (!next) {
        return true;
    }
    if (next === '[') {
        if (value[start + 2] === '<') {
            return !/[Mm]$/.test(value);
        }
        const code = value.charCodeAt(value.length - 1);
        return !(code >= 0x40 && code <= 0x7e);
    }
    if (next === ']') {
        return !(value.endsWith('\u0007') || value.endsWith('\u001b\\'));
    }
    return false;
}
class LlmHost {
    options;
    child;
    terminal;
    commands = new HostCommandRegistry();
    mode = 'child';
    commandBuffer = '';
    logicalLine = '';
    status = 'ready';
    confirmState = null;
    modalState = null;
    loadingStates = [];
    loadingFrame = 0;
    loadingTimer = null;
    commandPickerIndex = 0;
    commandHistory = [];
    commandHistoryIndex = null;
    commandHistoryDraft = '';
    bracketedPasteBuffer = null;
    pendingEscapeSequence = '';
    selection = null;
    renderQueued = false;
    lastRenderAt = 0;
    pendingWheelDelta = 0;
    wheelFlushQueued = false;
    runningLocalCommand = false;
    scrollOffset = 0;
    screenActive = false;
    lastRenderedRows = [];
    cols;
    rows;
    viewportRows;
    constructor(options) {
        this.options = options;
        this.cols = stdout.columns || 80;
        this.rows = stdout.rows || 24;
        this.viewportRows = this.childViewportRows();
        this.registerBuiltInCommands();
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
    hostApi() {
        return {
            registerCommand: (definition) => this.commands.register(definition),
            commands: () => this.commands.all(),
            setStatus: (message) => {
                this.status = message;
                this.queueRender();
            },
            confirm: (label, defaultValue) => this.confirm(label, defaultValue),
            confirmModal: (options) => this.confirmModal(options),
            showModal: (options) => this.showModal(options),
            withLoading: (label, action) => this.withLoading(label, action),
            withSuspendedScreen: (action) => this.withSuspendedScreen(action),
            inject: (text) => this.inject(text),
            log: (event, details) => logHostEvent(event, details),
        };
    }
    registerBuiltInCommands() {
        this.commands.register({
            command: 'help',
            description: 'show local commands',
            handler: () => {
                this.status = `commands: ${this.commands.all().map((definition) => `:${definition.command}`).join(', ')}`;
            },
        });
    }
    async loadConfiguredCommands() {
        let entries;
        try {
            entries = await readdir(HOST_COMMANDS_DIR, { withFileTypes: true });
        }
        catch (error) {
            if (isMissingDirectory(error)) {
                logHostEvent('commands.config_missing', { directory: HOST_COMMANDS_DIR });
                return;
            }
            throw error;
        }
        const commandFiles = entries
            .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
            .map((entry) => path.join(HOST_COMMANDS_DIR, entry.name))
            .sort();
        for (const commandFile of commandFiles) {
            try {
                const module = await tsImport(pathToFileURL(commandFile).href, {
                    parentURL: import.meta.url,
                    tsconfig: false,
                });
                const register = commandModuleRegister(module);
                if (!register) {
                    throw new Error('Command module must export register(host) or default register(host).');
                }
                await register(this.hostApi());
                logHostEvent('commands.config_loaded', { file: commandFile });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logHostEvent('commands.config_error', { file: commandFile, error: message });
                throw new Error(`Failed to load host command ${commandFile}: ${message}`);
            }
        }
    }
    async start() {
        if (!stdin.isTTY || !stdout.isTTY) {
            throw new Error('dev llm requires an interactive TTY.');
        }
        await this.loadConfiguredCommands();
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
        if (stdin.isTTY) {
            stdin.setRawMode(true);
            stdin.resume();
        }
        stdout.write('\x1b[?1049h\x1b[?25l\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[2J');
        this.lastRenderedRows = [];
    }
    exitScreen() {
        if (!this.screenActive) {
            return;
        }
        this.screenActive = false;
        this.clearLoadingTimer();
        if (stdin.isTTY) {
            stdin.setRawMode(false);
        }
        stdout.write('\x1b[?2004l\x1b[?1006l\x1b[?1002l\x1b[?25h\x1b[?1049l');
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
        this.lastRenderedRows = [];
        stdout.write('\x1b[2J');
        this.queueRender();
    }
    queueRender() {
        if (this.renderQueued) {
            return;
        }
        this.renderQueued = true;
        const now = Date.now();
        const delay = Math.max(0, RENDER_INTERVAL_MS - (now - this.lastRenderAt));
        setTimeout(() => {
            this.renderQueued = false;
            this.render();
        }, delay);
    }
    render() {
        if (!this.screenActive) {
            return;
        }
        this.lastRenderAt = Date.now();
        const buffer = this.terminal.buffer.active;
        const pickerRows = this.commandPickerRows();
        const bodyRows = this.viewportRows - pickerRows.length;
        const start = Math.max(0, buffer.baseY - this.scrollOffset);
        const rows = [];
        for (let row = 0; row < bodyRows; row += 1) {
            const bufferRow = start + row;
            rows.push(this.formatRow(renderStyledLine(buffer.getLine(bufferRow), this.cols, (column) => isPointSelected(this.selection, { row: bufferRow, column }))));
        }
        for (const pickerRow of pickerRows) {
            rows.push(this.formatRow(pickerRow));
        }
        rows.push(this.formatRow(dim('─'.repeat(this.cols))));
        rows.push(this.formatRow(this.commandBar()));
        if (this.modalState) {
            this.applyModal(rows);
        }
        let frame = '\x1b[?25l\x1b[?2026h';
        for (let row = 0; row < rows.length; row += 1) {
            if (rows[row] === this.lastRenderedRows[row]) {
                continue;
            }
            frame += `\x1b[${row + 1};1H${rows[row]}`;
        }
        frame += this.cursorSequence();
        frame += '\x1b[?2026l';
        stdout.write(frame);
        this.lastRenderedRows = rows;
    }
    formatRow(content) {
        const safeContent = visibleLength(content) > this.cols
            ? truncatePlain(stripAnsi(content), this.cols)
            : content;
        return padRight(safeContent, this.cols);
    }
    cursorSequence() {
        if (this.mode === 'command') {
            const column = Math.min(this.cols, visibleLength(`${blue('>')} `) + this.commandBuffer.length + 1);
            return `\x1b[${this.rows};${column}H\x1b[?25h`;
        }
        if (this.mode === 'confirm' && this.confirmState) {
            const column = Math.min(this.cols, visibleLength(this.confirmBar()) + 1);
            return `\x1b[${this.viewportRows + 2};${column}H\x1b[?25h`;
        }
        if (this.mode === 'modal') {
            return '\x1b[?25l';
        }
        if (this.scrollOffset > 0) {
            return '\x1b[?25l';
        }
        const buffer = this.terminal.buffer.active;
        const row = Math.max(1, Math.min(this.viewportRows, buffer.cursorY + 1));
        const column = Math.max(1, Math.min(this.cols, buffer.cursorX + 1));
        return `\x1b[${row};${column}H\x1b[?25h`;
    }
    commandBar() {
        if (this.mode === 'command') {
            const suggestion = commandSuggestion(this.commandBuffer, this.commands.all());
            return `${blue('>')} ${this.commandBuffer}${dim(suggestion)}`;
        }
        if (this.mode === 'confirm' && this.confirmState) {
            return this.confirmBar();
        }
        if (this.loadingStates.length > 0) {
            return this.loadingBar();
        }
        if (this.status !== 'ready') {
            return `${blue('>')} ${dim(this.status)}`;
        }
        return blue('>');
    }
    confirmBar() {
        if (!this.confirmState) {
            return '';
        }
        const yes = this.confirmState.value ? yellow(bold('Yes')) : dim('Yes');
        const no = this.confirmState.value ? dim('No') : yellow(bold('No'));
        return `${cyan('?')} ${bold(this.confirmState.label)}  ${yes}  ${no}`;
    }
    loadingBar() {
        const state = this.loadingStates[this.loadingStates.length - 1];
        if (!state) {
            return '';
        }
        const frame = LOADING_FRAMES[this.loadingFrame % LOADING_FRAMES.length];
        return `${blue('>')} ${yellow(frame)} ${dim(state.label)}`;
    }
    isAtPromptStart() {
        return this.logicalLine.length === 0 || this.terminal.buffer.active.cursorX === 0;
    }
    modalLine(content, width) {
        const innerWidth = Math.max(0, width - 4);
        const safeContent = visibleLength(content) > innerWidth
            ? truncatePlain(stripAnsi(content), innerWidth)
            : content;
        return modalPanel(`${modalBorderColor('│')} ${padRight(safeContent, innerWidth)} ${modalBorderColor('│')}`);
    }
    modalSelectedLine(content, width) {
        const innerWidth = Math.max(0, width - 4);
        const safeContent = visibleLength(content) > innerWidth
            ? truncatePlain(stripAnsi(content), innerWidth)
            : content;
        return modalPanel(`${modalBorderColor('│')} ${modalPanelSelected(padRight(safeContent, innerWidth))} ${modalBorderColor('│')}`);
    }
    modalBorder(left, fill, right, width) {
        return modalPanel(modalBorderColor(`${left}${fill.repeat(Math.max(0, width - 2))}${right}`));
    }
    modalBlank(width) {
        return this.modalLine('', width);
    }
    modalRows(width, maxHeight) {
        const modal = this.modalState;
        if (!modal) {
            return [];
        }
        const filteredItems = modal.kind === 'confirm' ? modal.items : filterModalItems(modal.allItems, modal.searchText);
        const itemRows = modal.kind === 'confirm' ? 1 : filteredItems.length > 0 ? 3 : 1;
        const searchLineCount = modal.searchMode ? 1 : 0;
        const maxVisibleItems = filteredItems.length > 0
            ? Math.max(1, Math.floor(Math.max(1, maxHeight - 5 - searchLineCount) / itemRows))
            : 0;
        const selectedIndex = Math.max(0, Math.min(modal.selectedIndex, Math.max(0, filteredItems.length - 1)));
        modal.selectedIndex = selectedIndex;
        if (filteredItems.length > 0) {
            modal.scrollOffset = Math.max(0, Math.min(modal.scrollOffset, Math.max(0, filteredItems.length - maxVisibleItems)));
            if (selectedIndex < modal.scrollOffset) {
                modal.scrollOffset = selectedIndex;
            }
            else if (selectedIndex >= modal.scrollOffset + maxVisibleItems) {
                modal.scrollOffset = selectedIndex - maxVisibleItems + 1;
            }
        }
        const visibleItems = filteredItems.slice(modal.scrollOffset, modal.scrollOffset + maxVisibleItems);
        const rows = [
            this.modalBorder('╭', '─', '╮', width),
            this.modalLine(modalAccent(bold(centerText(modal.title, Math.max(0, width - 4)))), width),
            this.modalBorder('├', '─', '┤', width),
            this.modalBlank(width),
        ];
        if (modal.searchMode) {
            const searchPrompt = `Search: ${modal.searchText}`;
            rows.push(this.modalLine(searchPrompt, width));
            rows.push(this.modalBlank(width));
        }
        if (modal.kind === 'confirm') {
            if (modal.emptyMessage) {
                rows.push(this.modalLine(modal.emptyMessage, width));
            }
            for (const item of filteredItems.slice(2)) {
                rows.push(this.modalLine(`  ${item.title}`, width));
            }
            const yes = modal.selectedIndex === 0 ? yellow(bold(filteredItems[0]?.title ?? 'Yes')) : filteredItems[0]?.title ?? 'Yes';
            const no = modal.selectedIndex === 1 ? yellow(bold(filteredItems[1]?.title ?? 'No')) : filteredItems[1]?.title ?? 'No';
            rows.push(this.modalBlank(width));
            rows.push(this.modalLine(`  ${modal.selectedIndex === 0 ? modalAccent('>') : ' '} ${yes}    ${modal.selectedIndex === 1 ? modalAccent('>') : ' '} ${no}`, width));
        }
        else if (visibleItems.length === 0) {
            const emptyMsg = modal.searchText ? `No matches for "${modal.searchText}"` : modal.emptyMessage ?? 'No items.';
            rows.push(this.modalLine(modalMuted(emptyMsg), width));
        }
        else {
            for (const [offset, item] of visibleItems.entries()) {
                const index = modal.scrollOffset + offset;
                const selected = index === selectedIndex;
                const marker = selected ? modalAccent('>') : ' ';
                const title = selected ? modalAccent(bold(item.title)) : item.title;
                const firstLine = `${marker} ${title}`;
                rows.push(selected ? this.modalSelectedLine(firstLine, width) : this.modalLine(firstLine, width));
                rows.push(this.modalLine(`  ${selected ? item.subtitle ?? '' : modalMuted(item.subtitle ?? '')}`, width));
                if (offset < visibleItems.length - 1) {
                    rows.push(this.modalBlank(width));
                }
            }
        }
        rows.push(this.modalBlank(width));
        rows.push(this.modalBorder('├', '─', '┤', width));
        const helpText = modal.searchMode
            ? 'Type to search  Escape clear  Enter done'
            : (modal.searchable && modal.kind !== 'confirm' ? `${modal.help ?? 'Enter select  r refresh  q close'}  / search` : modal.help ?? 'Enter select  r refresh  q close');
        rows.push(this.modalLine(modalMuted(helpText), width));
        rows.push(this.modalBorder('╰', '─', '╯', width));
        return rows.slice(0, maxHeight);
    }
    applyModal(rows) {
        const width = Math.min(this.cols, Math.max(64, Math.min(118, this.cols - 8, Math.floor(this.cols * 0.72))));
        const maxHeight = Math.max(9, Math.min(this.rows - 4, 22));
        const modalRows = this.modalRows(width, maxHeight);
        const top = Math.max(0, Math.floor((rows.length - modalRows.length) / 2));
        const left = Math.max(0, Math.floor((this.cols - width) / 2));
        for (let index = 0; index < modalRows.length && top + index < rows.length; index += 1) {
            const row = `${' '.repeat(left)}${modalRows[index]}${left + width < this.cols ? modalShadow('  ') : ''}`;
            rows[top + index] = this.formatRow(row);
        }
        const shadowRow = top + modalRows.length;
        if (shadowRow < rows.length) {
            rows[shadowRow] = this.formatRow(`${' '.repeat(Math.min(this.cols, left + 2))}${modalShadow(' '.repeat(Math.min(width, this.cols - left - 2)))}`);
        }
    }
    commandPickerEntries() {
        return this.commands.all()
            .map((command) => ({
            command,
            score: commandSearchScore(command, this.commandBuffer),
        }))
            .filter(({ score }) => score > 0)
            .sort((left, right) => {
            if (right.score !== left.score) {
                return right.score - left.score;
            }
            return left.command.command.localeCompare(right.command.command);
        });
    }
    selectedCommand() {
        const entries = this.commandPickerEntries();
        if (entries.length === 0) {
            return null;
        }
        const index = Math.max(0, Math.min(this.commandPickerIndex, entries.length - 1));
        return entries[index]?.command ?? null;
    }
    clampCommandPickerIndex() {
        const entries = this.commandPickerEntries();
        this.commandPickerIndex = Math.max(0, Math.min(this.commandPickerIndex, Math.max(0, entries.length - 1)));
    }
    resetCommandHistoryNavigation() {
        this.commandHistoryIndex = null;
        this.commandHistoryDraft = '';
    }
    pushCommandHistory(commandLine) {
        const command = commandLine.trim();
        if (!command) {
            return;
        }
        this.commandHistory = this.commandHistory.filter((entry) => entry !== command);
        this.commandHistory.push(command);
        if (this.commandHistory.length > 100) {
            this.commandHistory = this.commandHistory.slice(-100);
        }
        this.resetCommandHistoryNavigation();
    }
    navigateCommandHistory(delta) {
        if (this.commandHistory.length === 0) {
            return false;
        }
        if (this.commandHistoryIndex === null) {
            if (delta > 0) {
                return false;
            }
            this.commandHistoryDraft = this.commandBuffer;
            this.commandHistoryIndex = this.commandHistory.length - 1;
        }
        else {
            this.commandHistoryIndex += delta;
            if (this.commandHistoryIndex >= this.commandHistory.length) {
                this.commandHistoryIndex = null;
                this.commandBuffer = this.commandHistoryDraft;
                this.commandPickerIndex = 0;
                return true;
            }
            if (this.commandHistoryIndex < 0) {
                this.commandHistoryIndex = 0;
            }
        }
        this.commandBuffer = this.commandHistory[this.commandHistoryIndex] ?? this.commandHistoryDraft;
        this.commandPickerIndex = 0;
        return true;
    }
    commandPickerRows() {
        if (this.mode !== 'command') {
            return [];
        }
        const maxRows = Math.min(6, Math.max(0, this.viewportRows - 5));
        if (maxRows === 0) {
            return [];
        }
        const entries = this.commandPickerEntries();
        if (entries.length === 0) {
            return [dim('  no matching commands')];
        }
        this.clampCommandPickerIndex();
        const selectedIndex = this.commandPickerIndex;
        const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxRows / 2), Math.max(0, entries.length - maxRows)));
        const visible = entries.slice(start, start + maxRows);
        const commandWidth = Math.min(18, Math.max(...visible.map(({ command }) => command.command.length)) + 1);
        return visible.map(({ command }, offset) => {
            const absoluteIndex = start + offset;
            const selected = absoluteIndex === selectedIndex;
            const marker = selected ? yellow('>') : dim(' ');
            const commandText = `:${command.command.padEnd(commandWidth)}`;
            const aliasText = command.aliases?.length ? dim(` ${command.aliases.map((alias) => `:${alias}`).join(', ')}`) : '';
            const description = dim(command.description);
            return selected
                ? `${marker} ${yellow(bold(commandText))} ${description}${aliasText}`
                : `${marker} ${dim(commandText)} ${description}${aliasText}`;
        });
    }
    forwardPaste(content) {
        if (this.selection) {
            this.selection = null;
            this.queueRender();
        }
        if (this.scrollOffset > 0) {
            this.scrollToBottom();
        }
        if (this.options.bracketedPaste) {
            this.child.write(`${BRACKETED_PASTE_START}${content}${BRACKETED_PASTE_END}`);
        }
        else {
            this.child.write(content);
        }
        const lastNewline = Math.max(content.lastIndexOf('\n'), content.lastIndexOf('\r'));
        this.logicalLine = lastNewline === -1 ? `${this.logicalLine}${content}` : content.slice(lastNewline + 1);
    }
    handleBracketedPaste(data) {
        if (this.mode !== 'child' && this.bracketedPasteBuffer === null) {
            return false;
        }
        let remaining = data;
        if (this.bracketedPasteBuffer === null) {
            const start = remaining.indexOf(BRACKETED_PASTE_START);
            if (start === -1) {
                return false;
            }
            if (start > 0) {
                this.child.write(remaining.slice(0, start));
            }
            this.bracketedPasteBuffer = '';
            remaining = remaining.slice(start + BRACKETED_PASTE_START.length);
        }
        const end = remaining.indexOf(BRACKETED_PASTE_END);
        if (end === -1) {
            this.bracketedPasteBuffer += remaining;
            return true;
        }
        this.bracketedPasteBuffer += remaining.slice(0, end);
        const pasted = this.bracketedPasteBuffer;
        this.bracketedPasteBuffer = null;
        this.forwardPaste(pasted);
        const trailing = remaining.slice(end + BRACKETED_PASTE_END.length);
        if (trailing.length > 0) {
            this.child.write(trailing);
        }
        return true;
    }
    isLikelyPlainPaste(data) {
        if (data.includes(BRACKETED_PASTE_START) || data.includes(BRACKETED_PASTE_END)) {
            return true;
        }
        if (data.startsWith('\x1b')) {
            return false;
        }
        return (data.length > 1 && (data.includes('\n') || data.includes('\r'))) || data.length > 32;
    }
    onInput(chunk) {
        let data = chunk.toString('utf8');
        if (this.pendingEscapeSequence) {
            data = `${this.pendingEscapeSequence}${data}`;
            this.pendingEscapeSequence = '';
        }
        if (this.handleBracketedPaste(data)) {
            return;
        }
        if (this.mode === 'child' && this.isLikelyPlainPaste(data)) {
            this.forwardPaste(data);
            return;
        }
        for (let index = 0; index < data.length; index += 1) {
            const char = data[index];
            if (this.mode === 'confirm') {
                this.handleConfirmInput(data, index);
                return;
            }
            if (this.mode === 'modal') {
                this.handleModalInput(data, index);
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
                if (isIncompleteEscapeSequence(data, index, end)) {
                    this.pendingEscapeSequence = data.slice(index);
                    return;
                }
                const sequence = data.slice(index, end);
                if (!this.handleHostEscape(sequence)) {
                    this.child.write(sequence);
                }
                index = end - 1;
                continue;
            }
            if (this.selection) {
                this.selection = null;
                this.queueRender();
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
            if (char === this.options.prefix && this.isAtPromptStart()) {
                this.mode = 'command';
                this.commandBuffer = '';
                this.logicalLine = '';
                this.commandPickerIndex = 0;
                this.resetCommandHistoryNavigation();
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
            const end = escapeSequenceEnd(data, index);
            const sequence = data.slice(index, end);
            if (sequence === '\x1b[A') {
                if (!this.navigateCommandHistory(-1)) {
                    this.commandPickerIndex -= 1;
                    this.clampCommandPickerIndex();
                }
                return true;
            }
            if (sequence === '\x1b[B') {
                if (!this.navigateCommandHistory(1)) {
                    this.commandPickerIndex += 1;
                    this.clampCommandPickerIndex();
                }
                return true;
            }
            if (this.handleHostEscape(sequence)) {
                return true;
            }
            this.cancelCommandInput();
            return true;
        }
        if (char === '\r' || char === '\n') {
            const commandLine = this.commandBuffer.trim();
            const match = commandLine.length > 0 ? this.commands.match(commandLine) : null;
            if (!match) {
                const selected = this.selectedCommand();
                if (selected) {
                    this.commandBuffer = `${selected.command} `;
                    this.commandPickerIndex = 0;
                    this.status = 'ready';
                }
                else {
                    this.status = commandLine.length === 0 ? 'command cancelled' : `unknown command: ${commandLine}`;
                }
                return true;
            }
            this.mode = 'child';
            this.pushCommandHistory(commandLine);
            this.commandBuffer = '';
            this.logicalLine = '';
            this.status = `running :${commandLine}`;
            this.queueRender();
            void this.runLocalCommand(commandLine);
            return true;
        }
        if (char === '\u007f' || char === '\b') {
            this.commandBuffer = this.commandBuffer.slice(0, -1);
            this.commandPickerIndex = 0;
            this.resetCommandHistoryNavigation();
            return false;
        }
        if (char === '\t') {
            const suggestion = commandSuggestion(this.commandBuffer, this.commands.all());
            if (suggestion) {
                this.commandBuffer += suggestion;
                this.resetCommandHistoryNavigation();
            }
            else {
                const selected = this.selectedCommand();
                if (selected) {
                    this.commandBuffer = `${selected.command} `;
                    this.commandPickerIndex = 0;
                    this.resetCommandHistoryNavigation();
                }
            }
            return false;
        }
        if (char < ' ') {
            return false;
        }
        this.commandBuffer += char;
        this.commandPickerIndex = 0;
        this.resetCommandHistoryNavigation();
        return false;
    }
    finishModal(action) {
        const modal = this.modalState;
        if (!modal) {
            return;
        }
        const filteredItems = modal.kind === 'confirm' ? modal.items : filterModalItems(modal.allItems, modal.searchText);
        const index = Math.max(0, Math.min(modal.selectedIndex, Math.max(0, filteredItems.length - 1)));
        const item = filteredItems[index];
        this.modalState = null;
        this.mode = 'child';
        this.logicalLine = '';
        this.status = action === 'cancel' ? 'ready' : action;
        modal.resolve({ action, item, index });
        this.queueRender();
    }
    finishConfirmModal(value) {
        const modal = this.modalState;
        if (!modal) {
            return;
        }
        this.modalState = null;
        this.mode = 'child';
        this.logicalLine = '';
        this.status = value === 'cancel' ? 'cancelled' : `answered ${value ? 'yes' : 'no'}`;
        modal.resolve({
            action: value === 'cancel' ? 'cancel' : value ? 'primary' : 'secondary',
            index: value === true ? 0 : value === false ? 1 : -1,
        });
        this.queueRender();
    }
    moveModalSelection(delta) {
        const modal = this.modalState;
        if (!modal) {
            return;
        }
        const filteredItems = modal.kind === 'confirm' ? modal.items : filterModalItems(modal.allItems, modal.searchText);
        if (filteredItems.length === 0) {
            return;
        }
        modal.selectedIndex = Math.max(0, Math.min(filteredItems.length - 1, modal.selectedIndex + delta));
        this.queueRender();
    }
    handleModalInput(data, index) {
        const char = data[index];
        const modal = this.modalState;
        if (!modal) {
            this.mode = 'child';
            return;
        }
        if (modal.searchMode) {
            if (char === '') {
                const end = escapeSequenceEnd(data, index);
                const sequence = data.slice(index, end);
                if (sequence === '' || sequence === '[') {
                    modal.searchMode = false;
                    modal.searchText = '';
                    modal.selectedIndex = 0;
                    this.queueRender();
                    return;
                }
                return;
            }
            if (char === '\r' || char === '\n') {
                modal.searchMode = false;
                this.queueRender();
                return;
            }
            if (char === '' || char === '\b') {
                modal.searchText = modal.searchText.slice(0, -1);
                modal.selectedIndex = 0;
                this.queueRender();
                return;
            }
            if (char >= ' ' && char <= '~') {
                modal.searchText += char;
                modal.selectedIndex = 0;
                this.queueRender();
                return;
            }
            return;
        }
        if (char === '\u0003' || char === '\u0004' || char === 'q') {
            if (modal.kind === 'confirm') {
                this.finishConfirmModal('cancel');
            }
            else {
                this.finishModal('cancel');
            }
            return;
        }
        if (modal.kind === 'confirm') {
            if (char === '\r' || char === '\n') {
                this.finishConfirmModal(modal.selectedIndex === 0);
                return;
            }
            if (char === 'y') {
                this.finishConfirmModal(true);
                return;
            }
            if (char === 'n') {
                this.finishConfirmModal(false);
                return;
            }
            if (char === ' ' || char === '\t' || char === 'h' || char === 'l' || char === 'j' || char === 'k') {
                modal.selectedIndex = modal.selectedIndex === 0 ? 1 : 0;
                this.queueRender();
                return;
            }
        }
        if (char === '/' && modal.searchable && modal.kind !== 'confirm') {
            modal.searchMode = true;
            modal.searchText = '';
            modal.selectedIndex = 0;
            this.queueRender();
            return;
        }
        if (char === '\r' || char === '\n') {
            this.finishModal('primary');
            return;
        }
        if (char === 'y') {
            this.finishModal('secondary');
            return;
        }
        if (char === 'o') {
            this.finishModal('open');
            return;
        }
        if (char === 'r') {
            this.finishModal('refresh');
            return;
        }
        if (char === 'j') {
            this.moveModalSelection(1);
            return;
        }
        if (char === 'k') {
            this.moveModalSelection(-1);
            return;
        }
        if (char === '\u001b') {
            const end = escapeSequenceEnd(data, index);
            const sequence = data.slice(index, end);
            if (sequence === '\x1b[A') {
                if (modal.kind === 'confirm') {
                    modal.selectedIndex = modal.selectedIndex === 0 ? 1 : 0;
                    this.queueRender();
                }
                else {
                    this.moveModalSelection(-1);
                }
                return;
            }
            if (sequence === '\x1b[B') {
                if (modal.kind === 'confirm') {
                    modal.selectedIndex = modal.selectedIndex === 0 ? 1 : 0;
                    this.queueRender();
                }
                else {
                    this.moveModalSelection(1);
                }
                return;
            }
            if (sequence === '\x1b[D' || sequence === '\x1b[C') {
                if (modal.kind === 'confirm') {
                    modal.selectedIndex = modal.selectedIndex === 0 ? 1 : 0;
                    this.queueRender();
                    return;
                }
                this.finishModal('cancel');
                return;
            }
            if (sequence === '\x1b[5~') {
                this.moveModalSelection(-5);
                return;
            }
            if (sequence === '\x1b[6~') {
                this.moveModalSelection(5);
                return;
            }
            const mouse = parseMouseEvent(sequence);
            if (mouse && (mouse.button & 64) === 64) {
                this.moveModalSelection((mouse.button & 1) === 0 ? 3 : -3);
                return;
            }
            if (modal.kind === 'confirm') {
                this.finishConfirmModal('cancel');
            }
            else {
                this.finishModal('cancel');
            }
        }
    }
    handleHostEscape(sequence) {
        const mouse = parseMouseEvent(sequence);
        if (mouse) {
            this.handleMouse(mouse);
            return true;
        }
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
        return false;
    }
    handleMouse(event) {
        if ((event.button & 64) === 64) {
            this.queueWheelScroll((event.button & 1) === 0 ? 3 : -3);
            return;
        }
        const point = this.screenToBufferPoint(event.column, event.row);
        if (!point) {
            return;
        }
        const isLeftButton = (event.button & 3) === 0;
        const isLeftDrag = (event.button & 32) === 32 && isLeftButton;
        if (!event.released && event.button === 0) {
            this.selection = { anchor: point, focus: point, active: true, dragged: false };
            this.status = 'selecting';
            this.queueRender();
            return;
        }
        if (!event.released && isLeftDrag && this.selection?.active) {
            this.selection = { ...this.selection, focus: point, dragged: true };
            this.queueRender();
            return;
        }
        if (event.released && this.selection?.active) {
            if (!this.selection.dragged) {
                this.selection = null;
                this.status = 'ready';
                this.queueRender();
                return;
            }
            this.selection = { ...this.selection, focus: point, active: false };
            this.copySelection();
            this.queueRender();
        }
    }
    screenToBufferPoint(column, row) {
        const bodyRows = this.viewportRows - this.commandPickerRows().length;
        if (row < 1 || row > bodyRows) {
            return null;
        }
        const buffer = this.terminal.buffer.active;
        const start = Math.max(0, buffer.baseY - this.scrollOffset);
        return {
            row: start + row - 1,
            column: Math.max(0, Math.min(this.cols - 1, column - 1)),
        };
    }
    selectedText() {
        if (!this.selection) {
            return '';
        }
        const buffer = this.terminal.buffer.active;
        const { start, end } = selectionBounds(this.selection);
        const lines = [];
        for (let row = start.row; row <= end.row; row += 1) {
            const line = buffer.getLine(row);
            if (!line) {
                lines.push('');
                continue;
            }
            const startColumn = row === start.row ? start.column : 0;
            const endColumn = row === end.row ? end.column + 1 : this.cols;
            lines.push(line.translateToString(true, startColumn, endColumn));
        }
        return lines.join('\n');
    }
    copySelection() {
        const text = this.selectedText();
        if (!text) {
            this.status = 'selection empty';
            return;
        }
        const result = spawnSync('pbcopy', [], {
            input: text,
            stdio: ['pipe', 'ignore', 'ignore'],
        });
        this.status = result.status === 0 ? `copied ${text.length} chars` : 'selection ready';
    }
    maxScrollOffset() {
        const buffer = this.terminal.buffer.active;
        return Math.max(0, buffer.baseY);
    }
    scrollBy(delta) {
        if (delta === 0) {
            return;
        }
        const previousOffset = this.scrollOffset;
        this.scrollOffset = Math.max(0, Math.min(this.maxScrollOffset(), this.scrollOffset + delta));
        if (this.scrollOffset === previousOffset) {
            return;
        }
        this.status = this.scrollOffset > 0 ? 'scrolling; End returns to bottom' : 'ready';
        this.queueRender();
    }
    queueWheelScroll(delta) {
        this.pendingWheelDelta += delta;
        if (this.wheelFlushQueued) {
            return;
        }
        this.wheelFlushQueued = true;
        setTimeout(() => {
            this.wheelFlushQueued = false;
            const pending = this.pendingWheelDelta;
            this.pendingWheelDelta = 0;
            this.scrollBy(pending);
        }, WHEEL_FLUSH_MS);
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
    handleConfirmInput(data, index) {
        if (!this.confirmState) {
            return;
        }
        const char = data[index];
        const state = this.confirmState;
        const finish = (value) => {
            this.confirmState = null;
            this.mode = 'child';
            this.status = value === 'cancel' ? 'cancelled' : `answered ${value ? 'yes' : 'no'}`;
            state.resolve(value);
            this.queueRender();
        };
        const setValue = (value) => {
            state.value = value;
            this.queueRender();
        };
        if (char === '\u0003' || char === '\u0004') {
            finish('cancel');
            return;
        }
        if (char === '\u001b') {
            const end = escapeSequenceEnd(data, index);
            const sequence = data.slice(index, end);
            if (sequence === '\x1b[D' || sequence === '\x1b[C') {
                setValue(!state.value);
                return;
            }
            finish('cancel');
            return;
        }
        if (char === '\r' || char === '\n') {
            finish(state.value);
            return;
        }
        if (char === '\t' || char === ' ') {
            setValue(!state.value);
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
            this.confirmState = { label, value: defaultValue, resolve };
            this.queueRender();
        });
    }
    showModal(options) {
        this.mode = 'modal';
        this.status = options.title;
        return new Promise((resolve) => {
            this.modalState = {
                ...options,
                kind: 'list',
                selectedIndex: 0,
                scrollOffset: 0,
                resolve,
                searchText: '',
                searchMode: false,
                allItems: options.items,
            };
            this.queueRender();
        });
    }
    confirmModal(options) {
        const yesLabel = options.yesLabel ?? 'Yes';
        const noLabel = options.noLabel ?? 'No';
        this.mode = 'modal';
        this.status = options.title;
        const items = [
            { title: yesLabel },
            { title: noLabel },
            ...(options.details ?? []).map((detail) => ({ title: detail })),
        ];
        return new Promise((resolve) => {
            this.modalState = {
                title: options.title,
                emptyMessage: options.message,
                items,
                help: 'Enter select  y yes  n no  q cancel',
                kind: 'confirm',
                selectedIndex: options.defaultValue === false ? 1 : 0,
                scrollOffset: 0,
                resolve: (result) => {
                    if (result.action === 'cancel') {
                        resolve('cancel');
                    }
                    else {
                        resolve(result.action === 'primary');
                    }
                },
                searchText: '',
                searchMode: false,
                allItems: items,
            };
            this.queueRender();
        });
    }
    clearLoadingTimer() {
        if (!this.loadingTimer) {
            return;
        }
        clearInterval(this.loadingTimer);
        this.loadingTimer = null;
    }
    ensureLoadingTimer() {
        if (this.loadingTimer) {
            return;
        }
        this.loadingTimer = setInterval(() => {
            if (this.mode === 'confirm') {
                return;
            }
            this.loadingFrame += 1;
            this.queueRender();
        }, LOADING_INTERVAL_MS);
    }
    startLoading(label) {
        const id = Symbol(label);
        this.loadingStates.push({ id, label });
        this.ensureLoadingTimer();
        this.queueRender();
        return id;
    }
    stopLoading(id) {
        this.loadingStates = this.loadingStates.filter((state) => state.id !== id);
        if (this.loadingStates.length === 0) {
            this.clearLoadingTimer();
        }
        this.queueRender();
    }
    async yieldToRender() {
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
    }
    async withLoading(label, action) {
        const loading = this.startLoading(label);
        try {
            await this.yieldToRender();
            return await action();
        }
        finally {
            this.stopLoading(loading);
        }
    }
    async withSuspendedScreen(action) {
        this.exitScreen();
        try {
            return await action();
        }
        finally {
            this.enterScreen();
            this.queueRender();
        }
    }
    async runLocalCommand(commandLine) {
        if (this.runningLocalCommand) {
            logHostEvent('command.ignored_busy', { commandLine });
            return;
        }
        this.runningLocalCommand = true;
        logHostEvent('command.start', { commandLine });
        try {
            const match = this.commands.match(commandLine);
            if (!match) {
                const words = parseWords(commandLine);
                if (words.length > 0) {
                    this.status = `unknown command: ${words[0]}`;
                }
                logHostEvent('command.no_match', { commandLine, words });
                return;
            }
            logHostEvent('command.match', {
                commandLine,
                command: match.definition.command,
                matchedCommand: match.context.matchedCommand,
                args: match.context.args,
            });
            await this.withLoading(`running :${match.context.commandLine}`, () => match.definition.handler(match.context));
            logHostEvent('command.complete', {
                commandLine,
                command: match.definition.command,
            });
        }
        catch (error) {
            this.status = error instanceof Error ? error.message : String(error);
            logHostEvent('command.error', {
                commandLine,
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
            });
        }
        finally {
            this.runningLocalCommand = false;
            this.mode = 'child';
            this.logicalLine = '';
            this.queueRender();
        }
    }
    cancelCommandInput() {
        this.mode = 'child';
        this.commandBuffer = '';
        this.logicalLine = '';
        this.status = 'command cancelled';
        this.queueRender();
    }
    inject(text) {
        logHostEvent('inject.start', {
            chars: text.length,
            bracketedPaste: this.options.bracketedPaste,
        });
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
