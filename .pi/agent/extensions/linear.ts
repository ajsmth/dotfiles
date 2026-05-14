import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { complete, type UserMessage } from "@mariozechner/pi-ai";
import { BorderedLoader, DynamicBorder, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Input, Key, SelectList, Text, fuzzyFilter, matchesKey, type Focusable, type SelectItem } from "@mariozechner/pi-tui";

type TextBlock = {
	type: "text";
	text: string;
};

type SessionMessageEntry = {
	type: "message";
	message: {
		role?: string;
		content?: unknown;
	};
};

type LinearCommandContext = {
	hasUI: boolean;
	model?: {
		id: string;
		provider: string;
	};
	modelRegistry?: {
		getApiKeyAndHeaders(model: unknown): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>;
	};
	ui: {
		notify(message: string, level?: "info" | "success" | "warning" | "error"): void;
		select?(title: string, options: string[]): Promise<string | null>;
		setEditorText?(text: string): void;
		custom?<T>(
			factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => unknown,
			options?: { overlay?: boolean; overlayOptions?: unknown; onHandle?: (handle: unknown) => void },
		): Promise<T>;
	};
};

type LinearConfig = {
	teamKey: string;
	assignToMe: boolean;
	includeConversationContextByDefault: boolean;
	searchLimit: number;
};

type LinearWorkflowState = {
	id: string;
	name: string;
	type?: string | null;
	position?: number | null;
};

type LinearCycle = {
	id: string;
	name?: string | null;
	number?: number | null;
	startsAt?: string | null;
	endsAt?: string | null;
	issues?: {
		nodes: LinearIssue[];
	} | null;
};

type LinearTeam = {
	id: string;
	key: string;
	name: string;
	states?: {
		nodes: LinearWorkflowState[];
	} | null;
};

type LinearViewer = {
	id: string;
	name?: string | null;
	displayName?: string | null;
};

type LinearComment = {
	id: string;
	body?: string | null;
	createdAt?: string | null;
	user?: {
		name?: string | null;
		displayName?: string | null;
	} | null;
};

type LinearIssue = {
	id: string;
	identifier: string;
	title: string;
	description?: string | null;
	url?: string | null;
	team?: {
		key?: string | null;
		name?: string | null;
	} | null;
	state?: {
		id?: string | null;
		name?: string | null;
		type?: string | null;
	} | null;
	assignee?: {
		name?: string | null;
		displayName?: string | null;
	} | null;
	comments?: {
		nodes: LinearComment[];
	} | null;
};

type LinearGraphQLResponse<T> = {
	data?: T;
	errors?: Array<{ message?: string }>;
};

const LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "linear.json");
const MAX_CONVERSATION_MESSAGES = 6;
const MAX_CONVERSATION_CHARS = 4000;
const LINEAR_READ_COMMENT_LIMIT = 10;

const DEFAULT_CONFIG: LinearConfig = {
	teamKey: "REMY",
	assignToMe: true,
	includeConversationContextByDefault: true,
	searchLimit: 8,
};

const LINEAR_DESCRIPTION_SYSTEM_PROMPT = `You draft concise Linear issue descriptions from a title and recent conversation context.

Rules:
- Use only details supported by the provided context.
- Be concise and useful, not verbose.
- Focus on problem, relevant context, and expected outcome.
- Prefer short bullet lists when helpful.
- Do not invent acceptance criteria, owners, dates, or technical details that were not mentioned.
- If the conversation is not relevant to the title, return an empty string.
- Output plain text only.`;

function isSessionMessageEntry(entry: unknown): entry is SessionMessageEntry {
	return !!entry && typeof entry === "object" && (entry as { type?: string }).type === "message";
}

function extractTextParts(content: unknown): string[] {
	if (!Array.isArray(content)) {
		return [];
	}

	return content
		.filter((block): block is TextBlock => {
			return !!block && typeof block === "object" && (block as { type?: string }).type === "text" && typeof (block as { text?: unknown }).text === "string";
		})
		.map((block) => block.text);
}

function extractMessageText(message: { content?: unknown }): string {
	return extractTextParts(message.content).join("\n").trim();
}

function truncateText(text: string, maxChars: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxChars) {
		return trimmed;
	}
	return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function buildConversationContext(branch: unknown[]): string | undefined {
	const items: Array<{ role: string; text: string }> = [];
	let totalChars = 0;

	for (let i = branch.length - 1; i >= 0; i -= 1) {
		const entry = branch[i];
		if (!isSessionMessageEntry(entry)) {
			continue;
		}

		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") {
			continue;
		}

		const text = extractMessageText(entry.message);
		if (!text) {
			continue;
		}

		const truncated = truncateText(text, 900);
		if (!truncated) {
			continue;
		}

		items.unshift({ role, text: truncated });
		totalChars += truncated.length;
		if (items.length >= MAX_CONVERSATION_MESSAGES || totalChars >= MAX_CONVERSATION_CHARS) {
			break;
		}
	}

	if (items.length === 0) {
		return undefined;
	}

	const lines = ["Context from recent pi conversation:", ""];
	for (const item of items) {
		lines.push(`${item.role === "user" ? "User" : "Assistant"}:`);
		lines.push(item.text);
		lines.push("");
	}

	return lines.join("\n").trim();
}

function parseSubcommandArgs(args: string): { subcommand: string; rest: string } {
	const trimmed = args.trim();
	if (!trimmed) {
		return { subcommand: "", rest: "" };
	}

	const spaceIndex = trimmed.indexOf(" ");
	if (spaceIndex === -1) {
		return { subcommand: trimmed.toLowerCase(), rest: "" };
	}

	return {
		subcommand: trimmed.slice(0, spaceIndex).toLowerCase(),
		rest: trimmed.slice(spaceIndex + 1).trim(),
	};
}

function isTicketIdentifier(query: string): boolean {
	return /^[A-Za-z]+-\d+$/.test(query.trim());
}

function extractTicketIdentifierFromText(value: string): string | undefined {
	const match = value.match(/\b([A-Za-z]+-\d+)\b/);
	return match?.[1]?.toUpperCase();
}

function formatIssueLabel(issue: LinearIssue): string {
	const state = issue.state?.name ? ` [${issue.state.name}]` : "";
	const assignee = getAssigneeLabel(issue);
	return `${issue.identifier} · ${issue.title}${state}${assignee ? ` · ${assignee}` : ""}`;
}

function getAssigneeLabel(issue: LinearIssue): string | undefined {
	return issue.assignee?.displayName || issue.assignee?.name || undefined;
}

function isDoneState(issue: LinearIssue): boolean {
	return issue.state?.name?.trim().toLowerCase().startsWith("done") ?? false;
}

function getOrderedTeamStates(team: LinearTeam): LinearWorkflowState[] {
	return [...(team.states?.nodes ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

function formatStateChoiceLabel(state: LinearWorkflowState, currentStateId?: string | null): string {
	return state.id === currentStateId ? `${state.name} (current)` : state.name;
}

type LinearIssueSelectItem = SelectItem & { issue: LinearIssue };

class SearchableLinearIssuePicker implements Focusable {
	private readonly input: Input;
	private readonly topBorder: DynamicBorder;
	private readonly bottomBorder: DynamicBorder;
	private readonly titleText: Text;
	private readonly subtitleText?: Text;
	private readonly searchLabel: Text;
	private readonly footerText: Text;
	private readonly allItems: LinearIssueSelectItem[];
	private readonly done: (result: LinearIssue | null) => void;
	private readonly selectTheme: {
		selectedPrefix: (text: string) => string;
		selectedText: (text: string) => string;
		description: (text: string) => string;
		scrollInfo: (text: string) => string;
		noMatch: (text: string) => string;
	};
	private selectList: SelectList;
	private _focused = false;

	constructor(title: string, subtitle: string | undefined, issues: LinearIssue[], theme: any, done: (result: LinearIssue | null) => void) {
		this.done = done;
		this.topBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
		this.bottomBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
		this.titleText = new Text(theme.fg("accent", theme.bold(title)), 1, 0);
		this.subtitleText = subtitle ? new Text(theme.fg("muted", subtitle), 1, 0) : undefined;
		this.searchLabel = new Text(theme.fg("dim", "Filter issues (fuzzy):"), 1, 0);
		this.footerText = new Text(theme.fg("dim", "type to filter • ↑↓ navigate • enter select • esc cancel"), 1, 0);
		this.input = new Input();
		this.selectTheme = {
			selectedPrefix: (text: string) => theme.fg("accent", text),
			selectedText: (text: string) => theme.fg("accent", text),
			description: (text: string) => theme.fg("muted", text),
			scrollInfo: (text: string) => theme.fg("dim", text),
			noMatch: (text: string) => theme.fg("warning", text),
		};
		this.allItems = issues.map((issue) => ({
			value: issue.identifier,
			label: issue.identifier,
			description: `${issue.title}${issue.state?.name ? ` [${issue.state.name}]` : ""}`,
			issue,
		}));
		this.selectList = this.createSelectList(this.allItems);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	private createSelectList(items: LinearIssueSelectItem[]): SelectList {
		const selectList = new SelectList(items, Math.min(Math.max(items.length, 1), 10), this.selectTheme, {
			minPrimaryColumnWidth: 14,
			maxPrimaryColumnWidth: 20,
		});
		selectList.onSelect = (item) => this.done((item as LinearIssueSelectItem).issue);
		selectList.onCancel = () => this.done(null);
		return selectList;
	}

	private refreshList(): void {
		const query = this.input.getValue();
		const filtered = fuzzyFilter(this.allItems, query, (item) => `${item.value} ${item.description ?? ""}`);
		this.selectList = this.createSelectList(filtered);
	}

	render(width: number): string[] {
		const lines: string[] = [];
		lines.push(...this.topBorder.render(width));
		lines.push(...this.titleText.render(width));
		if (this.subtitleText) {
			lines.push(...this.subtitleText.render(width));
		}
		lines.push(...this.searchLabel.render(width));
		lines.push(...this.input.render(width));
		lines.push(...this.selectList.render(width));
		lines.push(...this.footerText.render(width));
		lines.push(...this.bottomBorder.render(width));
		return lines;
	}

	handleInput(data: string): void {
		if (
			matchesKey(data, Key.up)
			|| matchesKey(data, Key.down)
			|| matchesKey(data, Key.enter)
			|| matchesKey(data, Key.ctrl("p"))
			|| matchesKey(data, Key.ctrl("n"))
		) {
			const normalizedInput = matchesKey(data, Key.ctrl("p"))
				? "\u001b[A"
				: matchesKey(data, Key.ctrl("n"))
					? "\u001b[B"
					: data;
			this.selectList.handleInput(normalizedInput);
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.done(null);
			return;
		}
		this.input.handleInput(data);
		this.refreshList();
	}

	invalidate(): void {
		this.topBorder.invalidate();
		this.bottomBorder.invalidate();
		this.titleText.invalidate();
		this.subtitleText?.invalidate();
		this.searchLabel.invalidate();
		this.footerText.invalidate();
		this.input.invalidate();
		this.selectList.invalidate();
	}
}

function orderIssuesForSelection(issues: LinearIssue[]): LinearIssue[] {
	return issues
		.map((issue, index) => ({ issue, index }))
		.sort((a, b) => {
			const aDone = isDoneState(a.issue);
			const bDone = isDoneState(b.issue);
			if (aDone !== bDone) {
				return aDone ? 1 : -1;
			}
			return a.index - b.index;
		})
		.map(({ issue }) => issue);
}

async function runWithLinearLoading<T>(
	ctx: LinearCommandContext,
	message: string,
	action: (signal?: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
	if (!ctx.hasUI || !ctx.ui.custom) {
		ctx.ui.notify(message, "info");
		return action();
	}

	const CANCELLED = Symbol("cancelled");
	const FAILED = Symbol("failed");
	let taskError: unknown;

	const result = await ctx.ui.custom<T | typeof CANCELLED | typeof FAILED>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui as never, theme as never, message);
		loader.onAbort = () => done(CANCELLED);

		action(loader.signal)
			.then(done)
			.catch((error) => {
				if (loader.signal.aborted) {
					done(CANCELLED);
					return;
				}
				taskError = error;
				done(FAILED);
			});

		return loader;
	});

	if (result === CANCELLED) {
		ctx.ui.notify("Cancelled Linear request", "info");
		return undefined;
	}
	if (result === FAILED) {
		throw taskError;
	}
	return result;
}

async function draftLinearDescription(
	ctx: LinearCommandContext,
	title: string,
	conversationContext?: string,
	signal?: AbortSignal,
): Promise<string> {
	if (!conversationContext) {
		return "";
	}
	if (!ctx.model || !ctx.modelRegistry) {
		return conversationContext;
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok || !auth.apiKey) {
		return conversationContext;
	}

	const userMessage: UserMessage = {
		role: "user",
		content: [
			{
				type: "text",
				text: [`Title: ${title}`, "", conversationContext].join("\n"),
			},
		],
		timestamp: Date.now(),
	};

	const response = await complete(
		ctx.model,
		{ systemPrompt: LINEAR_DESCRIPTION_SYSTEM_PROMPT, messages: [userMessage] },
		{ apiKey: auth.apiKey, headers: auth.headers, signal },
	);

	if (response.stopReason === "aborted") {
		return "";
	}

	return response.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

async function readConfig(): Promise<LinearConfig> {
	try {
		const raw = await readFile(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(raw) as Partial<LinearConfig>;
		return {
			teamKey: typeof parsed.teamKey === "string" && parsed.teamKey.trim() ? parsed.teamKey.trim() : DEFAULT_CONFIG.teamKey,
			assignToMe: parsed.assignToMe ?? DEFAULT_CONFIG.assignToMe,
			includeConversationContextByDefault:
				parsed.includeConversationContextByDefault ?? DEFAULT_CONFIG.includeConversationContextByDefault,
			searchLimit:
				typeof parsed.searchLimit === "number" && Number.isFinite(parsed.searchLimit) && parsed.searchLimit > 0
					? Math.min(20, Math.max(1, Math.floor(parsed.searchLimit)))
					: DEFAULT_CONFIG.searchLimit,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return DEFAULT_CONFIG;
		}
		throw error;
	}
}

async function linearRequest<T>(
	apiKey: string,
	query: string,
	variables?: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<T> {
	const response = await fetch(LINEAR_ENDPOINT, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: apiKey,
		},
		body: JSON.stringify({ query, variables }),
		signal,
	});

	if (!response.ok) {
		throw new Error(`Linear API request failed: ${response.status} ${response.statusText}`);
	}

	const payload = (await response.json()) as LinearGraphQLResponse<T>;
	if (payload.errors && payload.errors.length > 0) {
		throw new Error(payload.errors.map((error) => error.message || "Unknown Linear API error").join("\n"));
	}
	if (!payload.data) {
		throw new Error("Linear API returned no data");
	}
	return payload.data;
}

async function resolveLinearContext(
	apiKey: string,
	teamKey: string,
	signal?: AbortSignal,
): Promise<{ viewer: LinearViewer; team: LinearTeam }> {
	const data = await linearRequest<{
		viewer: LinearViewer;
		teams: { nodes: LinearTeam[] };
	}>(
		apiKey,
		`
			query ResolveLinearContext($teamKey: String!) {
				viewer {
					id
					name
					displayName
				}
				teams(filter: { key: { eq: $teamKey } }) {
					nodes {
						id
						key
						name
						states(first: 50) {
							nodes {
								id
								name
								type
								position
							}
						}
					}
				}
			}
		`,
		{ teamKey },
		signal,
	);

	const team = data.teams.nodes[0];
	if (!team) {
		throw new Error(`Could not find Linear team with key ${teamKey}`);
	}

	return { viewer: data.viewer, team };
}

async function createLinearIssue(args: {
	apiKey: string;
	teamId: string;
	assigneeId?: string;
	title: string;
	description?: string;
	signal?: AbortSignal;
}): Promise<LinearIssue> {
	const input: Record<string, unknown> = {
		teamId: args.teamId,
		title: args.title,
	};
	if (args.assigneeId) {
		input.assigneeId = args.assigneeId;
	}
	if (args.description?.trim()) {
		input.description = args.description.trim();
	}

	const data = await linearRequest<{
		issueCreate: {
			success: boolean;
			issue?: LinearIssue | null;
		};
	}>(
		args.apiKey,
		`
			mutation CreateIssue($input: IssueCreateInput!) {
				issueCreate(input: $input) {
					success
					issue {
						id
						identifier
						title
						url
					}
				}
			}
		`,
		{ input },
		args.signal,
	);

	if (!data.issueCreate.success || !data.issueCreate.issue) {
		throw new Error("Linear did not return a created issue");
	}

	return data.issueCreate.issue;
}

async function getLinearIssueDetails(args: {
	apiKey: string;
	issueId: string;
	signal?: AbortSignal;
}): Promise<LinearIssue> {
	const data = await linearRequest<{
		issue?: LinearIssue | null;
	}>(
		args.apiKey,
		`
			query IssueDetails($id: String!, $commentLimit: Int!) {
				issue(id: $id) {
					id
					identifier
					title
					description
					url
					team {
						key
						name
					}
					state {
						id
						name
						type
					}
					assignee {
						name
						displayName
					}
					comments(first: $commentLimit, orderBy: createdAt) {
						nodes {
							id
							body
						}
					}
				}
			}
		`,
		{ id: args.issueId, commentLimit: LINEAR_READ_COMMENT_LIMIT },
		args.signal,
	);

	if (!data.issue) {
		throw new Error(`Linear issue not found: ${args.issueId}`);
	}

	return data.issue;
}

async function searchLinearIssues(args: {
	apiKey: string;
	query: string;
	limit: number;
	teamId?: string;
	teamKey?: string;
	signal?: AbortSignal;
}): Promise<LinearIssue[]> {
	const term = isTicketIdentifier(args.query) ? args.query.toUpperCase() : args.query;
	const data = await linearRequest<{
		searchIssues: { nodes: LinearIssue[] };
	}>(
		args.apiKey,
		`
			query SearchIssues($term: String!, $first: Int!, $teamId: String) {
				searchIssues(term: $term, first: $first, teamId: $teamId) {
					nodes {
						id
						identifier
						title
						description
						url
						team {
							key
							name
						}
						state {
							id
							name
						}
						assignee {
							name
							displayName
						}
					}
				}
			}
		`,
		{ term, first: args.limit, teamId: args.teamId },
		args.signal,
	);

	const exactIdentifierMatches = isTicketIdentifier(args.query)
		? data.searchIssues.nodes.filter((issue) => issue.identifier.toUpperCase() === term)
		: [];
	if (exactIdentifierMatches.length > 0) {
		return exactIdentifierMatches;
	}

	const teamFiltered = args.teamKey
		? data.searchIssues.nodes.filter((issue) => issue.team?.key?.toUpperCase() === args.teamKey?.toUpperCase())
		: data.searchIssues.nodes;
	return teamFiltered.length > 0 ? teamFiltered : data.searchIssues.nodes;
}

async function getRecentAssignedIssues(args: {
	apiKey: string;
	assigneeId: string;
	teamId: string;
	limit: number;
	signal?: AbortSignal;
}): Promise<LinearIssue[]> {
	const data = await linearRequest<{
		issues: { nodes: LinearIssue[] };
	}>(
		args.apiKey,
		`
			query RecentAssignedIssues($assigneeId: ID!, $teamId: ID!, $first: Int!) {
				issues(
					filter: {
						assignee: { id: { eq: $assigneeId } }
						team: { id: { eq: $teamId } }
						state: { type: { nin: ["completed", "canceled"] } }
					}
					first: $first
					orderBy: updatedAt
				) {
					nodes {
						id
						identifier
						title
						description
						url
						team {
							key
							name
						}
						state {
							id
							name
						}
						assignee {
							name
							displayName
						}
					}
				}
			}
		`,
		{ assigneeId: args.assigneeId, teamId: args.teamId, first: args.limit },
		args.signal,
	);

	return data.issues.nodes;
}

async function getAssignedOpenIssues(args: {
	apiKey: string;
	teamId: string;
	assigneeId: string;
	limit: number;
	signal?: AbortSignal;
}): Promise<LinearIssue[]> {
	const data = await linearRequest<{
		issues: { nodes: LinearIssue[] };
	}>(
		args.apiKey,
		`
			query AssignedOpenIssues($teamId: ID!, $assigneeId: ID!, $first: Int!) {
				issues(
					filter: {
						team: { id: { eq: $teamId } }
						assignee: { id: { eq: $assigneeId } }
						state: { type: { nin: ["completed", "canceled"] } }
					}
					first: $first
					orderBy: updatedAt
				) {
					nodes {
						id
						identifier
						title
						description
						url
						team {
							key
							name
						}
						state {
							id
							name
							type
						}
						assignee {
							name
							displayName
						}
					}
				}
			}
		`,
		{ teamId: args.teamId, assigneeId: args.assigneeId, first: args.limit },
		args.signal,
	);

	return data.issues.nodes;
}

async function pickLinearIssue(
	ctx: LinearCommandContext,
	title: string,
	issues: LinearIssue[],
	options?: { searchable?: boolean; subtitle?: string },
): Promise<LinearIssue | undefined> {
	if (issues.length === 0) {
		return undefined;
	}
	if (!ctx.hasUI) {
		return issues[0];
	}
	if (options?.searchable && ctx.ui.custom) {
		const selected = await ctx.ui.custom<LinearIssue | null>((tui, theme, _keybindings, done) => {
			const picker = new SearchableLinearIssuePicker(title, options.subtitle, issues, theme, done);
			picker.focused = true;
			return {
				get focused() {
					return picker.focused;
				},
				set focused(value: boolean) {
					picker.focused = value;
				},
				render: (width: number) => picker.render(width),
				invalidate: () => picker.invalidate(),
				handleInput: (data: string) => {
					picker.handleInput(data);
					(tui as { requestRender?: () => void }).requestRender?.();
				},
			};
		});
		return selected ?? undefined;
	}
	if (!ctx.ui.select) {
		return issues[0];
	}
	const selectedLabel = await ctx.ui.select(title, issues.map((issue) => formatIssueLabel(issue)));
	if (!selectedLabel) {
		return undefined;
	}
	return issues.find((issue) => formatIssueLabel(issue) === selectedLabel) ?? issues[0];
}

function formatAssignedIssuesSummary(team: LinearTeam, viewer: LinearViewer): string {
	return `${team.key} · assigned to ${viewer.displayName || viewer.name || "me"}`;
}

function formatLinearAgentPrompt(args: { team: LinearTeam; viewer: LinearViewer; config: LinearConfig }): string {
	const states = getOrderedTeamStates(args.team);
	const lines = [
		"Use this Linear context to help with my next request.",
		"",
		"<linear_agent_context>",
		"Authentication:",
		"- Use the LINEAR_API_KEY environment variable for Linear API requests.",
		`- GraphQL endpoint: ${LINEAR_ENDPOINT}`,
		"- Prefer using a short Node.js, Python, or curl script from the shell when you need to query Linear.",
		"",
		"Default workspace context:",
		`- Team key: ${args.config.teamKey}`,
		`- Team: ${args.team.name} (${args.team.key})`,
		`- Team ID: ${args.team.id}`,
		`- Viewer: ${args.viewer.displayName || args.viewer.name || "me"}`,
		`- Viewer ID: ${args.viewer.id}`,
		`- Assign new issues to viewer by default: ${args.config.assignToMe ? "yes" : "no"}`,
		"",
		"Workflow states:",
		...(states.length > 0
			? states.map((state) => `- ${state.name} (${state.id})${state.type ? ` — type: ${state.type}` : ""}`)
			: ["- No workflow states loaded"]),
		"",
		"Useful GraphQL operations:",
		"",
		"Search issues:",
		"query SearchIssues($term: String!, $teamId: String) {",
		"  searchIssues(term: $term, first: 10, teamId: $teamId) {",
		"    nodes { id identifier title description url state { id name type } assignee { name displayName } }",
		"  }",
		"}",
		"",
		"Read issue by id/identifier:",
		"query Issue($id: String!) {",
		"  issue(id: $id) {",
		"    id identifier title description url state { id name type } assignee { id name displayName }",
		"    comments(first: 20, orderBy: createdAt) { nodes { id body createdAt user { name displayName } } }",
		"  }",
		"}",
		"",
		"Create issue:",
		"mutation CreateIssue($input: IssueCreateInput!) {",
		"  issueCreate(input: $input) { success issue { id identifier title url } }",
		"}",
		"Input example: { teamId, title, description, assigneeId }",
		"",
		"Update issue:",
		"mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {",
		"  issueUpdate(id: $id, input: $input) { success issue { id identifier title state { id name } } }",
		"}",
		"Input examples: { stateId }, { assigneeId }, { title }, { description }",
		"",
		"Add comment:",
		"mutation AddComment($input: CommentCreateInput!) {",
		"  commentCreate(input: $input) { success comment { id url body } }",
		"}",
		"Input example: { issueId, body }",
		"",
		"Safety rules:",
		"- Read/query freely when needed.",
		"- Ask for confirmation before creating issues, changing status/assignee/title/description, or adding comments unless I explicitly asked for that exact mutation.",
		"- Prefer concise summaries of fetched Linear data.",
		"- Do not expose LINEAR_API_KEY in output or logs.",
		"</linear_agent_context>",
		"",
		"Request:",
	];

	return lines.join("\n");
}

function formatLinearIssuePrompt(issue: LinearIssue): string {
	const lines = [
		"Use this Linear ticket as context for my next request.",
		"",
		"<linear_ticket>",
		`Identifier: ${issue.identifier}`,
		`Title: ${issue.title}`,
	];

	if (issue.url) {
		lines.push(`URL: ${issue.url}`);
	}
	if (issue.team?.key || issue.team?.name) {
		lines.push(`Team: ${[issue.team.key, issue.team.name].filter(Boolean).join(" · ")}`);
	}
	if (issue.state?.name) {
		lines.push(`Status: ${issue.state.name}`);
	}
	const assignee = getAssigneeLabel(issue);
	if (assignee) {
		lines.push(`Assignee: ${assignee}`);
	}

	lines.push("", "Description:", issue.description?.trim() || "(No description)");

	const comments = issue.comments?.nodes.map((comment) => comment.body?.trim()).filter((body): body is string => !!body) ?? [];
	lines.push("", `Comments (latest ${LINEAR_READ_COMMENT_LIMIT}, body only):`);
	if (comments.length === 0) {
		lines.push("(No comments)");
	} else {
		comments.forEach((comment, index) => {
			if (index > 0) {
				lines.push("");
			}
			lines.push(comment);
		});
	}

	lines.push("</linear_ticket>", "", "Request:");
	return lines.join("\n");
}

function copyToClipboard(text: string): boolean {
	const value = `${text.trim()}\n`;

	const commands: Array<{ command: string; args?: string[] }> = process.platform === "darwin"
		? [{ command: "pbcopy" }]
		: [
				{ command: "wl-copy" },
				{ command: "xclip", args: ["-selection", "clipboard"] },
				{ command: "pbcopy" },
		  ];

	for (const candidate of commands) {
		const result = spawnSync(candidate.command, candidate.args ?? [], {
			input: value,
			encoding: "utf8",
			stdio: ["pipe", "ignore", "ignore"],
		});
		if (result.status === 0) {
			return true;
		}
	}

	return false;
}

async function getCurrentGitBranch(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	const result = await pi.exec("git", ["branch", "--show-current"], { cwd, timeout: 5_000 });
	if (result.code !== 0) {
		return undefined;
	}
	const branch = result.stdout.trim();
	return branch || undefined;
}

async function openInBrowser(pi: ExtensionAPI, url: string): Promise<boolean> {
	const candidates = process.platform === "darwin"
		? [{ command: "open", args: [url] }]
		: process.platform === "win32"
			? [{ command: "cmd", args: ["/c", "start", "", url] }]
			: [{ command: "xdg-open", args: [url] }];

	for (const candidate of candidates) {
		const result = await pi.exec(candidate.command, candidate.args, { timeout: 5_000 });
		if (result.code === 0) {
			return true;
		}
	}

	return false;
}

function getActionChoices(issue: LinearIssue): string[] {
	const choices = ["Move to status...", "Copy ticket ID", "Use ticket ID in prompt"];
	if (issue.url) {
		choices.push("Open in browser");
	}
	choices.push("Cancel");
	return choices;
}

function resolveQuickState(team: LinearTeam, target: "start" | "done" | "backlog"): LinearWorkflowState | undefined {
	const states = getOrderedTeamStates(team);
	const exactMatch = (pattern: RegExp): LinearWorkflowState | undefined => states.find((state) => pattern.test(state.name));
	const firstByType = (type: string): LinearWorkflowState | undefined => states.find((state) => state.type?.toLowerCase() === type);

	if (target === "start") {
		return exactMatch(/^in progress$/i)
			?? exactMatch(/^in progress \(eng\)$/i)
			?? exactMatch(/^in progress/i)
			?? exactMatch(/^ready for dev$/i)
			?? firstByType("started")
			?? firstByType("unstarted");
	}

	if (target === "done") {
		return exactMatch(/^done$/i) ?? firstByType("completed");
	}

	return exactMatch(/^backlog$/i) ?? exactMatch(/^triage$/i) ?? firstByType("backlog") ?? firstByType("unstarted");
}

async function updateLinearIssueState(args: {
	apiKey: string;
	issueId: string;
	stateId: string;
	signal?: AbortSignal;
}): Promise<LinearIssue> {
	const data = await linearRequest<{
		issueUpdate: {
			success: boolean;
			issue?: LinearIssue | null;
		};
	}>(
		args.apiKey,
		`
			mutation UpdateIssueState($id: String!, $input: IssueUpdateInput!) {
				issueUpdate(id: $id, input: $input) {
					success
					issue {
						id
						identifier
						title
						url
						state {
							id
							name
						}
					}
				}
			}
		`,
		{ id: args.issueId, input: { stateId: args.stateId } },
		args.signal,
	);

	if (!data.issueUpdate.success || !data.issueUpdate.issue) {
		throw new Error("Linear did not return an updated issue");
	}

	return data.issueUpdate.issue;
}

async function handleLinearIssueActions(args: {
	ctx: LinearCommandContext;
	pi: ExtensionAPI;
	apiKey: string;
	team: LinearTeam;
	issue: LinearIssue;
}): Promise<void> {
	const { ctx, pi, apiKey, team, issue } = args;
	const details = [issue.identifier, issue.title];
	if (issue.state?.name) {
		details.push(`State: ${issue.state.name}`);
	}
	const assignee = getAssigneeLabel(issue);
	if (assignee) {
		details.push(`Assignee: ${assignee}`);
	}
	if (!ctx.hasUI) {
		ctx.ui.notify(details.concat(issue.url ? [issue.url] : []).join("\n"), "info");
		return;
	}
	if (!ctx.ui.select) {
		ctx.ui.notify(details.concat(issue.url ? [issue.url] : []).join("\n"), "info");
		return;
	}

	for (;;) {
		const action = await ctx.ui.select(`${issue.identifier} · ${issue.title}`, getActionChoices(issue));
		if (!action || action === "Cancel") {
			ctx.ui.notify("No action taken", "info");
			return;
		}

		if (action === "Move to status...") {
			const states = getOrderedTeamStates(team);
			if (states.length === 0) {
				ctx.ui.notify(`No workflow states found for team ${team.key}`, "error");
				return;
			}

			const selectedStateLabel = await ctx.ui.select(
				`Move ${issue.identifier} to...`,
				states.map((state) => formatStateChoiceLabel(state, issue.state?.id)),
			);
			if (!selectedStateLabel) {
				continue;
			}

			const targetState = states.find((state) => formatStateChoiceLabel(state, issue.state?.id) === selectedStateLabel);
			if (!targetState) {
				ctx.ui.notify("Could not resolve selected Linear status", "error");
				continue;
			}
			if (issue.state?.id === targetState.id) {
				ctx.ui.notify(`${issue.identifier} is already in ${targetState.name}`, "info");
				continue;
			}

			const updated = await runWithLinearLoading(ctx, `Updating ${issue.identifier}...`, (signal) =>
				updateLinearIssueState({
					apiKey,
					issueId: issue.id,
					stateId: targetState.id,
					signal,
				}),
			);
			if (!updated) {
				return;
			}

			ctx.ui.notify(`Updated ${updated.identifier} to ${updated.state?.name || targetState.name}`, "success");
			return;
		}

		if (action === "Copy ticket ID") {
			const copied = copyToClipboard(issue.identifier);
			ctx.ui.notify(
				copied ? `Copied ${issue.identifier} to the clipboard` : `Could not copy automatically. Ticket: ${issue.identifier}`,
				copied ? "success" : "warning",
			);
			return;
		}

		if (action === "Use ticket ID in prompt") {
			ctx.ui.setEditorText?.(issue.identifier);
			ctx.ui.notify(`Replaced editor text with ${issue.identifier}`, "success");
			return;
		}

		if (action === "Open in browser" && issue.url) {
			const opened = await openInBrowser(pi, issue.url);
			ctx.ui.notify(
				opened ? `Opened ${issue.identifier} in your browser` : `Could not open browser automatically. URL: ${issue.url}`,
				opened ? "success" : "warning",
			);
			return;
		}

		ctx.ui.notify(details.concat(issue.url ? [issue.url] : []).join("\n"), "info");
		return;
	}
}

export default function linearExtension(pi: ExtensionAPI): void {
	let configCache: LinearConfig | undefined;
	let contextCache: { viewer: LinearViewer; team: LinearTeam } | undefined;
	let contextCacheKey: string | undefined;

	async function getConfig(): Promise<LinearConfig> {
		configCache ||= await readConfig();
		return configCache;
	}

	async function getLinearContext(
		apiKey: string,
		signal?: AbortSignal,
	): Promise<{ viewer: LinearViewer; team: LinearTeam; config: LinearConfig }> {
		const config = await getConfig();
		const cacheKey = `${apiKey}:${config.teamKey}`;
		if (!contextCache || contextCacheKey !== cacheKey) {
			contextCache = await resolveLinearContext(apiKey, config.teamKey, signal);
			contextCacheKey = cacheKey;
		}
		return { ...contextCache, config };
	}

	function getApiKey(): string {
		const apiKey = process.env.LINEAR_API_KEY?.trim();
		if (!apiKey) {
			throw new Error("LINEAR_API_KEY is not set. Add it to your shell and restart pi.");
		}
		return apiKey;
	}

	pi.registerCommand("linear", {
		description: "Create, find, update, browse, or read current sprint Linear issues",
		getArgumentCompletions: (prefix) => {
			const trimmed = prefix.trimStart();
			if (!trimmed || !trimmed.includes(" ")) {
				const subcommands = ["agent", "create", "find", "ticket", "task", "tasks", "start", "done", "backlog"];
				const filtered = subcommands.filter((item) => item.startsWith(trimmed.toLowerCase()));
				return filtered.length > 0 ? filtered.map((item) => ({ value: item, label: item })) : null;
			}
			const { subcommand, rest } = parseSubcommandArgs(trimmed);
			if (subcommand === "ticket" && !rest.includes(" ")) {
				const actions = ["read"];
				const filtered = actions.filter((item) => item.startsWith(rest.toLowerCase()));
				return filtered.length > 0 ? filtered.map((item) => ({ value: `ticket ${item}`, label: item })) : null;
			}
			return null;
		},
		handler: async (rawArgs, ctx) => {
			try {
				const { subcommand, rest } = parseSubcommandArgs(rawArgs);
				if (!subcommand) {
					ctx.ui.notify("Usage: /linear agent | /linear create [title] | /linear ticket | /linear ticket read [ticket-or-query] | /linear find [query] | /linear task | /linear tasks | /linear start|done|backlog [query]", "info");
					return;
				}

				const apiKey = getApiKey();
				const linearContext = await runWithLinearLoading(ctx, "Loading Linear...", (signal) => getLinearContext(apiKey, signal));
				if (!linearContext) {
					return;
				}
				const { viewer, team, config } = linearContext;

				if (subcommand === "agent") {
					if (!ctx.hasUI || !ctx.ui.setEditorText) {
						ctx.ui.notify(formatLinearAgentPrompt({ team, viewer, config }), "info");
						return;
					}
					ctx.ui.setEditorText(formatLinearAgentPrompt({ team, viewer, config }));
					ctx.ui.notify("Loaded Linear agent context into the prompt", "success");
					return;
				}

				if (subcommand === "create") {
					let title = rest;
					if (!title) {
						if (!ctx.hasUI) {
							ctx.ui.notify("Usage: /linear create <title>", "warning");
							return;
						}
						const input = await ctx.ui.input(`Create issue in ${team.key}`, "Title");
						if (!input) {
							ctx.ui.notify("Cancelled Linear issue creation", "info");
							return;
						}
						title = input.trim();
					}

					const suggestedContext = buildConversationContext(ctx.sessionManager.getBranch());
					const draftedDescription = await runWithLinearLoading(ctx, "Drafting Linear description...", (signal) =>
						draftLinearDescription(ctx, title, suggestedContext, signal),
					);
					if (draftedDescription === undefined) {
						ctx.ui.notify("Cancelled Linear issue creation", "info");
						return;
					}
					const description = draftedDescription.trim();

					if (ctx.hasUI) {
						const confirmed = await ctx.ui.confirm(
							`Create ${team.key} issue?`,
							`Title: ${title}\nAssignee: ${viewer.displayName || viewer.name || "me"}${description ? `\nDescription: ${truncateText(description, 300)}` : ""}`,
						);
						if (!confirmed) {
							ctx.ui.notify("Cancelled Linear issue creation", "info");
							return;
						}
					}

					const created = await runWithLinearLoading(ctx, `Creating ${team.key} issue...`, (signal) =>
						createLinearIssue({
							apiKey,
							teamId: team.id,
							assigneeId: config.assignToMe ? viewer.id : undefined,
							title,
							description,
							signal,
						}),
					);
					if (!created) {
						return;
					}

					const urlText = created.url ? `\n${created.url}` : "";
					ctx.ui.notify(`Created ${created.identifier}: ${created.title}${urlText}`, "success");
					return;
				}

				if (subcommand === "ticket") {
					const { subcommand: ticketAction, rest: ticketRest } = parseSubcommandArgs(rest);
					if (!ticketAction) {
						const branch = await getCurrentGitBranch(pi, ctx.cwd);
						if (!branch) {
							ctx.ui.notify("Could not determine current git branch", "warning");
							return;
						}

						const ticketId = extractTicketIdentifierFromText(branch);
						if (!ticketId) {
							ctx.ui.notify(`No Linear ticket ID found in branch: ${branch}`, "warning");
							return;
						}

						const issues = await runWithLinearLoading(ctx, `Loading ${ticketId} from Linear...`, (signal) =>
							searchLinearIssues({
								apiKey,
								query: ticketId,
								limit: config.searchLimit,
								teamId: team.id,
								teamKey: config.teamKey,
								signal,
							}),
						);
						if (!issues || issues.length === 0) {
							ctx.ui.notify(`No Linear issue found for ${ticketId}`, "info");
							return;
						}

						const issue = issues.find((item) => item.identifier.toUpperCase() === ticketId) ?? issues[0];
						await handleLinearIssueActions({ ctx, pi, apiKey, team, issue });
						return;
					}
					if (ticketAction !== "read") {
						ctx.ui.notify("Usage: /linear ticket | /linear ticket read [ticket-or-query]", "info");
						return;
					}

					let query = ticketRest;
					if (!query) {
						const branch = await runWithLinearLoading(ctx, "Reading current git branch...", () =>
							getCurrentGitBranch(pi, ctx.cwd),
						);
						if (!branch) {
							ctx.ui.notify("Could not determine current git branch. Usage: /linear ticket read <ticket-or-query>", "warning");
							return;
						}

						const ticketId = extractTicketIdentifierFromText(branch);
						if (!ticketId) {
							ctx.ui.notify(`No Linear ticket ID found in branch: ${branch}. Usage: /linear ticket read <ticket-or-query>`, "warning");
							return;
						}
						query = ticketId;
					}

					const issues = await runWithLinearLoading(ctx, `Loading ${query} from Linear...`, (signal) =>
						searchLinearIssues({
							apiKey,
							query,
							limit: config.searchLimit,
							teamId: team.id,
							teamKey: config.teamKey,
							signal,
						}),
					);
					if (!issues || issues.length === 0) {
						ctx.ui.notify(`No Linear issue found for: ${query}`, "info");
						return;
					}

					const exactTicketId = isTicketIdentifier(query) ? query.toUpperCase() : undefined;
					const selectedIssue = exactTicketId
						? issues.find((item) => item.identifier.toUpperCase() === exactTicketId) ?? issues[0]
						: await pickLinearIssue(ctx, "Matching Linear issues", orderIssuesForSelection(issues));
					if (!selectedIssue) {
						ctx.ui.notify("Cancelled Linear issue selection", "info");
						return;
					}

					const detailedIssue = await runWithLinearLoading(ctx, `Loading ${selectedIssue.identifier} details and comments...`, (signal) =>
						getLinearIssueDetails({
							apiKey,
							issueId: selectedIssue.id,
							signal,
						}),
					);
					if (!detailedIssue) {
						return;
					}

					const prompt = formatLinearIssuePrompt(detailedIssue);
					if (!ctx.hasUI || !ctx.ui.setEditorText) {
						ctx.ui.notify(prompt, "info");
						return;
					}

					ctx.ui.setEditorText(prompt);
					ctx.ui.notify(`Loaded ${detailedIssue.identifier} and latest ${LINEAR_READ_COMMENT_LIMIT} comments into the prompt`, "success");
					return;
				}

				if (subcommand === "task") {
					const branch = await getCurrentGitBranch(pi, ctx.cwd);
					if (!branch) {
						ctx.ui.notify("Could not determine current git branch", "warning");
						return;
					}

					const ticketId = extractTicketIdentifierFromText(branch);
					if (!ticketId) {
						ctx.ui.notify(`No Linear ticket ID found in branch: ${branch}`, "warning");
						return;
					}

					const issues = await runWithLinearLoading(ctx, `Loading ${ticketId} from Linear...`, (signal) =>
						searchLinearIssues({
							apiKey,
							query: ticketId,
							limit: config.searchLimit,
							teamId: team.id,
							teamKey: config.teamKey,
							signal,
						}),
					);
					if (!issues || issues.length === 0) {
						ctx.ui.notify(`No Linear issue found for ${ticketId}`, "info");
						return;
					}

					const issue = issues.find((item) => item.identifier.toUpperCase() === ticketId) ?? issues[0];
					await handleLinearIssueActions({ ctx, pi, apiKey, team, issue });
					return;
				}

				if (subcommand === "tasks") {
					if (!ctx.hasUI) {
						ctx.ui.notify("/linear tasks requires interactive mode", "warning");
						return;
					}

					const issues = await runWithLinearLoading(ctx, "Loading your Linear tasks...", (signal) =>
						getAssignedOpenIssues({
							apiKey,
							teamId: team.id,
							assigneeId: viewer.id,
							limit: 50,
							signal,
						}),
					);
					if (!issues) {
						return;
					}

					const orderedIssues = orderIssuesForSelection(issues);
					if (orderedIssues.length === 0) {
						ctx.ui.notify(`No assigned open tasks found for ${team.key}`, "info");
						return;
					}

					const selectedIssue = await pickLinearIssue(ctx, "My tasks", orderedIssues, {
						searchable: true,
						subtitle: formatAssignedIssuesSummary(team, viewer),
					});
					if (!selectedIssue) {
						ctx.ui.notify("Cancelled Linear task selection", "info");
						return;
					}

					await handleLinearIssueActions({ ctx, pi, apiKey, team, issue: selectedIssue });
					return;
				}

				if (subcommand === "find" || subcommand === "start" || subcommand === "done" || subcommand === "backlog") {
					let query = rest;
					if (!query && subcommand !== "find" && !ctx.hasUI) {
						ctx.ui.notify(`Usage: /linear ${subcommand} <query>`, "warning");
						return;
					}
					if (!query && subcommand === "find") {
						if (!ctx.hasUI) {
							ctx.ui.notify("Usage: /linear find <query>", "warning");
							return;
						}
						const input = await ctx.ui.input("Find Linear issue", "Search by title or ticket ID");
						if (!input) {
							ctx.ui.notify("Cancelled Linear issue search", "info");
							return;
						}
						query = input.trim();
					}

					const issues = query
						? await runWithLinearLoading(ctx, "Searching Linear...", (signal) =>
								searchLinearIssues({
									apiKey,
									query,
									limit: config.searchLimit,
									teamId: team.id,
									teamKey: config.teamKey,
									signal,
								}),
						  )
						: await runWithLinearLoading(ctx, "Loading your recent Linear issues...", (signal) =>
								getRecentAssignedIssues({
									apiKey,
									assigneeId: viewer.id,
									teamId: team.id,
									limit: Math.max(config.searchLimit, 12),
									signal,
								}),
						  );
					if (!issues) {
						return;
					}

					const orderedIssues = orderIssuesForSelection(issues);
					if (orderedIssues.length === 0) {
						ctx.ui.notify(
							query ? `No Linear issues found for: ${query}` : "No recent assigned Linear issues found",
							"info",
						);
						return;
					}

					const selectedIssue = await pickLinearIssue(
						ctx,
						query ? "Matching Linear issues" : "Recent assigned Linear issues",
						orderedIssues,
						query ? undefined : { searchable: true, subtitle: `${team.key} · assigned to ${viewer.displayName || viewer.name || "me"}` },
					);
					if (!selectedIssue) {
						ctx.ui.notify("Cancelled Linear issue selection", "info");
						return;
					}

					if (subcommand === "start" || subcommand === "done" || subcommand === "backlog") {
						const targetState = resolveQuickState(team, subcommand);
						if (!targetState) {
							ctx.ui.notify(`Could not find a ${subcommand} status in team ${team.key}`, "error");
							return;
						}
						if (selectedIssue.state?.id === targetState.id) {
							ctx.ui.notify(`${selectedIssue.identifier} is already in ${targetState.name}`, "info");
							return;
						}

						const updated = await runWithLinearLoading(ctx, `Updating ${selectedIssue.identifier}...`, (signal) =>
							updateLinearIssueState({
								apiKey,
								issueId: selectedIssue.id,
								stateId: targetState.id,
								signal,
							}),
						);
						if (!updated) {
							return;
						}

						ctx.ui.notify(`Updated ${updated.identifier} to ${updated.state?.name || targetState.name}`, "success");
						return;
					}
					await handleLinearIssueActions({ ctx, pi, apiKey, team, issue: selectedIssue });
					return;
				}

				ctx.ui.notify(`Unknown /linear subcommand: ${subcommand}`, "warning");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
