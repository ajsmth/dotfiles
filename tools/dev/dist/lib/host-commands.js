export function commandNames(commands) {
    return commands.flatMap((command) => [command.command, ...(command.aliases ?? [])]);
}
export function commandSuggestion(commandBuffer, commands) {
    if (commandBuffer.length === 0) {
        return '';
    }
    const matches = commandNames(commands)
        .filter((command) => command.startsWith(commandBuffer));
    if (matches.length === 0) {
        return '';
    }
    const commonPrefix = matches.reduce((prefix, command) => {
        let index = 0;
        while (index < prefix.length && index < command.length && prefix[index] === command[index]) {
            index += 1;
        }
        return prefix.slice(0, index);
    });
    return commonPrefix === commandBuffer ? '' : commonPrefix.slice(commandBuffer.length);
}
export function commandMatches(commandBuffer, commands) {
    const query = commandBuffer.trimStart();
    if (query.length === 0) {
        return [...commands];
    }
    const exactMatches = commands.filter((command) => commandNames([command]).some((name) => name.startsWith(query)));
    if (exactMatches.length > 0) {
        return exactMatches;
    }
    const group = query.split(/\s+/)[0];
    if (!group) {
        return [];
    }
    return commands.filter((command) => commandNames([command]).some((name) => name === group || name.startsWith(`${group} `)));
}
export function parseWords(input) {
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
function commandBoundaryMatches(input, command) {
    return input === command || input.startsWith(`${command} `);
}
export class HostCommandRegistry {
    definitions = [];
    register(definition) {
        const names = commandNames([definition]);
        const existing = this.definitions.find((candidate) => commandNames([candidate]).some((name) => names.includes(name)));
        if (existing) {
            throw new Error(`Duplicate host command: ${names.find((name) => commandNames([existing]).includes(name)) ?? definition.command}`);
        }
        this.definitions.push(definition);
    }
    all() {
        return this.definitions;
    }
    match(commandLine) {
        const input = commandLine.trim();
        if (!input) {
            return null;
        }
        const candidates = this.definitions
            .flatMap((definition) => commandNames([definition]).map((name) => ({ definition, name })))
            .sort((left, right) => parseWords(right.name).length - parseWords(left.name).length || right.name.length - left.name.length);
        for (const candidate of candidates) {
            if (!commandBoundaryMatches(input, candidate.name)) {
                continue;
            }
            const args = input.slice(candidate.name.length).trimStart();
            return {
                definition: candidate.definition,
                context: {
                    commandLine: input,
                    matchedCommand: candidate.name,
                    args,
                    argsWords: parseWords(args),
                },
            };
        }
        return null;
    }
}
