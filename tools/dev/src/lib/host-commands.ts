export type CommandHandoff = {
  prompts: string[];
};

export type HostCommandMetadata = {
  command: string;
  description: string;
  handoff?: CommandHandoff;
  aliases?: string[];
};

export type HostCommandRunContext = {
  commandLine: string;
  matchedCommand: string;
  args: string;
  argsWords: string[];
};

export type HostCommandDefinition = HostCommandMetadata & {
  handler: (context: HostCommandRunContext) => Promise<void> | void;
};

export type HostModalItem = {
  title: string;
  subtitle?: string;
  value?: string;
  url?: string;
};

export type HostModalOptions = {
  title: string;
  items: HostModalItem[];
  emptyMessage?: string;
  help?: string;
  searchable?: boolean;
};

export type HostConfirmModalOptions = {
  title: string;
  message: string;
  details?: string[];
  defaultValue?: boolean;
  yesLabel?: string;
  noLabel?: string;
};

export type HostModalResult = {
  action: 'primary' | 'secondary' | 'open' | 'refresh' | 'cancel';
  item?: HostModalItem;
  index: number;
};

export type HostExtensionApi = {
  registerCommand(definition: HostCommandDefinition): void;
  commands(): readonly HostCommandMetadata[];
  setStatus(message: string): void;
  confirm(label: string, defaultValue: boolean): Promise<boolean | 'cancel'>;
  confirmModal(options: HostConfirmModalOptions): Promise<boolean | 'cancel'>;
  showModal(options: HostModalOptions): Promise<HostModalResult>;
  withLoading<T>(label: string, action: () => Promise<T> | T): Promise<T>;
  withSuspendedScreen<T>(action: () => Promise<T> | T): Promise<T>;
  inject(text: string): void;
  log(event: string, details?: Record<string, unknown>): void;
};

export function commandNames(commands: readonly HostCommandMetadata[]): string[] {
  return commands.flatMap((command) => [command.command, ...(command.aliases ?? [])]);
}

export function commandSuggestion(commandBuffer: string, commands: readonly HostCommandMetadata[]): string {
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

export function commandMatches(commandBuffer: string, commands: readonly HostCommandMetadata[]): HostCommandMetadata[] {
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

export function parseWords(input: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
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
      } else {
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

function commandBoundaryMatches(input: string, command: string): boolean {
  return input === command || input.startsWith(`${command} `);
}

export class HostCommandRegistry {
  private readonly definitions: HostCommandDefinition[] = [];

  register(definition: HostCommandDefinition): void {
    const names = commandNames([definition]);
    const existing = this.definitions.find((candidate) => commandNames([candidate]).some((name) => names.includes(name)));
    if (existing) {
      throw new Error(`Duplicate host command: ${names.find((name) => commandNames([existing]).includes(name)) ?? definition.command}`);
    }

    this.definitions.push(definition);
  }

  all(): readonly HostCommandDefinition[] {
    return this.definitions;
  }

  match(commandLine: string): { definition: HostCommandDefinition; context: HostCommandRunContext } | null {
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
