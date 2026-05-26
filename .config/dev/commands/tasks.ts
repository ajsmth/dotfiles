import { spawnSync } from 'node:child_process';
import { stdout } from 'node:process';

type Host = {
  registerCommand(definition: HostCommandDefinition): void;
  setStatus(message: string): void;
  withLoading<T>(label: string, action: () => Promise<T> | T): Promise<T>;
  showModal(options: HostModalOptions): Promise<HostModalResult>;
  log(event: string, details?: Record<string, unknown>): void;
};

type HostCommandDefinition = {
  command: string;
  description: string;
  aliases?: string[];
  handler(): Promise<void> | void;
};

type HostModalItem = {
  title: string;
  subtitle?: string;
  value?: string;
  url?: string;
};

type HostModalOptions = {
  title: string;
  items: HostModalItem[];
  emptyMessage?: string;
  help?: string;
};

type HostModalResult = {
  action: 'primary' | 'secondary' | 'open' | 'refresh' | 'cancel';
  item?: HostModalItem;
  index: number;
};

type LinearResponse<T> = {
  data?: T;
  errors?: { message?: string }[];
};

type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  priority: number;
  estimate: number | null;
  dueDate: string | null;
  updatedAt: string;
  archivedAt: string | null;
  url: string;
  state: {
    name: string;
    type: string;
    position: number;
  } | null;
  team: {
    key: string;
    name: string;
  } | null;
  project: {
    name: string;
  } | null;
  cycle: {
    name: string;
    number: number;
  } | null;
};

type MyTasksData = {
  viewer: {
    name: string;
    assignedIssues: {
      nodes: LinearIssue[];
    };
  };
};

const LINEAR_ENDPOINT = 'https://api.linear.app/graphql';
const TASK_LIMIT = 100;

const MY_TASKS_QUERY = `
  query MyTasks($first: Int!) {
    viewer {
      name
      assignedIssues(first: $first) {
        nodes {
          id
          identifier
          title
          priority
          estimate
          dueDate
          updatedAt
          archivedAt
          url
          state {
            name
            type
            position
          }
          team {
            key
            name
          }
          project {
            name
          }
          cycle {
            name
            number
          }
        }
      }
    }
  }
`;

function apiKey(): string {
  const value = process.env.LINEAR_API_KEY ?? process.env.LINEAR_TOKEN;
  if (!value) {
    throw new Error('Set LINEAR_API_KEY to a Linear personal API key before using :tasks.');
  }

  return value;
}

async function linearGraphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(LINEAR_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey(),
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await response.text();
  let payload: LinearResponse<T>;
  try {
    payload = JSON.parse(text) as LinearResponse<T>;
  } catch {
    throw new Error(`Linear returned ${response.status}: ${text.slice(0, 200)}`);
  }

  if (!response.ok) {
    throw new Error(payload.errors?.map((error) => error.message).filter(Boolean).join('; ') || `Linear returned ${response.status}`);
  }

  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).filter(Boolean).join('; '));
  }

  if (!payload.data) {
    throw new Error('Linear returned no data.');
  }

  return payload.data;
}

function priorityLabel(priority: number): string {
  switch (priority) {
    case 1:
      return 'Urgent';
    case 2:
      return 'High';
    case 3:
      return 'Normal';
    case 4:
      return 'Low';
    default:
      return '-';
  }
}

function stateRank(issue: LinearIssue): number {
  const type = issue.state?.type.toLowerCase() ?? '';
  if (type === 'started') return 0;
  if (type === 'unstarted') return 1;
  if (type === 'triage') return 2;
  if (type === 'backlog') return 3;
  return 4;
}

function priorityRank(priority: number): number {
  return priority === 0 ? 99 : priority;
}

function currentIssues(issues: LinearIssue[]): LinearIssue[] {
  return issues
    .filter((issue) => {
      const stateType = issue.state?.type.toLowerCase() ?? '';
      return !issue.archivedAt && !['completed', 'canceled', 'cancelled'].includes(stateType);
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function truncate(value: string, width: number): string {
  if (width <= 0) return '';
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return width <= 3 ? value.slice(0, width) : `${value.slice(0, width - 3)}...`;
}

function formatDueDate(value: string | null): string {
  return value ?? '-';
}

function scope(issue: LinearIssue): string {
  if (issue.cycle) return `C${issue.cycle.number}`;
  if (issue.project) return issue.project.name;
  return issue.team?.key ?? '-';
}

function copy(value: string): boolean {
  const result = spawnSync('pbcopy', [], {
    input: value,
    stdio: ['pipe', 'ignore', 'ignore'],
  });

  return result.status === 0;
}

function openUrl(value: string): boolean {
  const result = spawnSync('open', [value], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  return result.status === 0;
}

function modalItem(issue: LinearIssue): HostModalItem {
  const titleWidth = Math.max(24, Math.min(72, (stdout.columns || 100) - 42));
  const subtitle = [
    issue.state?.name ?? '-',
    priorityLabel(issue.priority),
    `Due ${formatDueDate(issue.dueDate)}`,
    scope(issue),
  ].join('  ');

  return {
    title: `${issue.identifier}  ${truncate(issue.title, titleWidth)}`,
    subtitle,
    value: issue.identifier,
    url: issue.url,
  };
}

async function fetchTasks(): Promise<{ viewer: string; issues: LinearIssue[] }> {
  const data = await linearGraphql<MyTasksData>(MY_TASKS_QUERY, { first: TASK_LIMIT });
  return {
    viewer: data.viewer.name,
    issues: currentIssues(data.viewer.assignedIssues.nodes),
  };
}

async function showTasks(host: Host): Promise<void> {
  while (true) {
    const { viewer, issues } = await host.withLoading('Reading Linear tasks', fetchTasks);
    const result = await host.showModal({
      title: `Linear tasks for ${viewer}`,
      items: issues.map(modalItem),
      emptyMessage: 'No current assigned tasks.',
      help: 'j/k arrows move  Enter open  y copy ID  o copy URL  r refresh  q close',
      searchable: true,
    });

    if (result.action === 'refresh') {
      continue;
    }

    if (result.action === 'cancel' || !result.item) {
      host.setStatus('ready');
      return;
    }

    if (result.action === 'primary') {
      const url = result.item.url;
      if (url && openUrl(url)) {
        host.setStatus(`opened ${result.item.value ?? 'issue'}`);
      } else {
        host.setStatus(`open failed: ${result.item.value ?? 'issue'}`);
      }
      return;
    }

    if (result.action === 'secondary') {
      const value = result.item.value;
      if (!value) {
        host.setStatus('nothing to copy');
        return;
      }
      host.setStatus(copy(value) ? `copied ${value}` : `copy failed: ${value}`);
      host.log('command.tasks.copy', { action: 'copy_id', value });
      return;
    }

    if (result.action === 'open') {
      const url = result.item.url;
      if (!url) {
        host.setStatus('no URL to copy');
        return;
      }
      host.setStatus(copy(url) ? `copied URL for ${result.item.value ?? 'issue'}` : `copy failed`);
      host.log('command.tasks.copy', { action: 'copy_url', value: result.item.value, url });
      return;
    }

    host.setStatus('ready');
    return;
  }
}

export function register(host: Host): void {
  host.registerCommand({
    command: 'tasks',
    description: 'show current Linear tasks and copy an issue ID',
    aliases: ['task', 'tickets', 'ticket'],
    handler: async () => {
      await showTasks(host);
    },
  });
}
