import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chat, stripMarkdownFence } from './llm.js';
import { run } from './process.js';
import { printKeyValue, printSection, promptYesNo, step } from './ui.js';
const SUBMIT_BODY_START = '<!-- dev-cli:summary:start -->';
const SUBMIT_BODY_END = '<!-- dev-cli:summary:end -->';
function fail(message) {
    throw new Error(message);
}
function git(args, cwd, allowFailure = false) {
    return run('git', args, { cwd, allowFailure });
}
function gh(args, cwd, allowFailure = false) {
    return run('gh', args, { cwd, allowFailure });
}
function clean(value) {
    return value.trim();
}
function gitOutput(args, cwd) {
    return clean(git(args, cwd).stdout);
}
async function maybeStep(agent, label, action) {
    return agent ? action() : step(label, action);
}
function printJson(value) {
    console.log(JSON.stringify(value, null, 2));
}
function printNeedsInput(value) {
    printJson(value);
}
function gitRebaseContinue(repoRoot) {
    return run('git', ['rebase', '--continue'], {
        cwd: repoRoot,
        allowFailure: true,
        env: {
            GIT_EDITOR: 'true',
        },
    });
}
function pluralize(count, singular, plural = `${singular}s`) {
    return count === 1 ? singular : plural;
}
async function pathExists(pathname) {
    return access(pathname).then(() => true).catch(() => false);
}
function ensureCleanWorktree(repoRoot) {
    const status = gitOutput(['status', '--porcelain'], repoRoot);
    if (status !== '') {
        fail('Working tree is not clean. Commit, stash, or discard local changes before rebasing.');
    }
}
function currentBranch(repoRoot) {
    const branch = gitOutput(['branch', '--show-current'], repoRoot);
    if (!branch) {
        fail('Current HEAD is detached. Check out a branch before rebasing.');
    }
    return branch;
}
function resolveDefaultBranch(repoRoot, remote) {
    const remoteHead = git(['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`], repoRoot, true);
    const remoteHeadName = clean(remoteHead.stdout);
    if (remoteHead.status === 0 && remoteHeadName.startsWith(`${remote}/`)) {
        return remoteHeadName.slice(remote.length + 1);
    }
    if (git(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/main`], repoRoot, true).status === 0) {
        return 'main';
    }
    if (git(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/master`], repoRoot, true).status === 0) {
        return 'master';
    }
    fail(`Could not resolve ${remote}'s default branch.`);
}
function resolveForkPoint(repoRoot, target) {
    const forkPoint = git(['merge-base', '--fork-point', target, 'HEAD'], repoRoot, true);
    if (forkPoint.status === 0 && clean(forkPoint.stdout)) {
        return clean(forkPoint.stdout);
    }
    return gitOutput(['merge-base', target, 'HEAD'], repoRoot);
}
function commitCountSince(repoRoot, ref) {
    return Number.parseInt(gitOutput(['rev-list', '--count', `${ref}..HEAD`], repoRoot), 10);
}
function truncateBytes(value, maxBytes) {
    const encoded = Buffer.from(value, 'utf8');
    if (encoded.byteLength <= maxBytes) {
        return value;
    }
    return `${encoded.subarray(0, maxBytes).toString('utf8')}\n\n[truncated]`;
}
function conventionalCommitRules(subjectName) {
    return [
        `${subjectName} must use conventional commit syntax, including a scope.`,
        `${subjectName} must use exactly this shape: type(scope): imperative summary.`,
        'Use one of these types only: feat, fix, refactor, chore, docs, test, build, ci, perf, style.',
        'The scope should name the changed domain inferred from the file paths, branch, or comments.',
        'The summary should be specific, imperative, and under 72 characters when practical.',
    ];
}
function shellQuote(value) {
    return `'${value.replaceAll("'", "'\\''")}'`;
}
async function readOptionalBody(options) {
    if (options.bodyFile && options.bodyFile.trim() !== '') {
        return readFile(options.bodyFile, 'utf8').then((value) => value.trim());
    }
    return options.body?.trim() || undefined;
}
function fallbackCommitMessage(repoRoot, forkPoint) {
    const firstSubject = git(['log', '--reverse', '--format=%s', `${forkPoint}..HEAD`], repoRoot, true)
        .stdout
        .split('\n')
        .map((line) => line.trim())
        .find(Boolean);
    return {
        subject: firstSubject || 'chore(repo): squash branch changes',
        body: 'Squash branch commits before rebasing onto the current upstream base.',
    };
}
function hasStagedChanges(repoRoot) {
    return git(['diff', '--cached', '--quiet', '--ignore-submodules', '--'], repoRoot, true).status !== 0;
}
function hasUnstagedOrUntrackedChanges(repoRoot) {
    return git(['status', '--porcelain'], repoRoot).stdout
        .split('\n')
        .some((line) => {
        if (line.length < 2) {
            return false;
        }
        return line.startsWith('??') || line[1] !== ' ';
    });
}
function fallbackSubmitContent(repoRoot, diffRange, branch) {
    const files = gitOutput(['diff', '--name-only', diffRange], repoRoot)
        .split('\n')
        .map((file) => file.trim())
        .filter(Boolean);
    const firstFile = files[0] ?? branch;
    const scope = firstFile
        .split('/')[0]
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase() || 'repo';
    const subject = `chore(${scope}): update ${scope} changes`;
    const body = [
        '## Summary',
        `- Updates ${scope} changes from the current branch.`,
        files.length > 0 ? `- Touches ${files.slice(0, 5).join(', ')}.` : '- Includes local repository changes.',
        '',
        '## Testing',
        '- Not run.',
    ].join('\n');
    return {
        commitSubject: subject,
        commitBody: 'Update local changes for submission.',
        prTitle: subject,
        prBody: body,
    };
}
async function generateSubmitContent(repoRoot, branch, baseRef, diffRange, options) {
    const stat = gitOutput(['diff', '--shortstat', diffRange], repoRoot);
    const files = gitOutput(['diff', '--name-status', diffRange], repoRoot);
    const commits = git(['log', '--reverse', '--format=%s', diffRange], repoRoot, true).stdout.trim();
    const diff = truncateBytes(gitOutput(['diff', '--no-ext-diff', '--minimal', diffRange], repoRoot), Number.parseInt(process.env.DEV_LLM_MAX_DIFF_BYTES ?? '40000', 10));
    const systemPrompt = [
        'You prepare git commits and GitHub pull requests for an engineer.',
        'Return valid JSON with exactly these keys: commitSubject, commitBody, prTitle, prBody.',
        ...conventionalCommitRules('commitSubject'),
        ...conventionalCommitRules('prTitle'),
        'The PR body must be concise markdown with Summary and Testing sections.',
        'Explain what changed and why when the branch name, commit subjects, or diff provide enough context.',
        'Do not invent testing that did not happen.',
    ].join('\n');
    const userPrompt = [
        `Repository: ${path.basename(repoRoot)}`,
        `Branch: ${branch}`,
        `Base ref: ${baseRef}`,
        `Stats: ${stat || 'n/a'}`,
        '',
        'Commit subjects already on branch:',
        commits || 'n/a',
        '',
        'Files:',
        files || 'n/a',
        '',
        'Diff:',
        diff || 'n/a',
    ].join('\n');
    try {
        const raw = await chat(systemPrompt, userPrompt, options);
        const parsed = JSON.parse(stripMarkdownFence(raw));
        const commitSubject = typeof parsed.commitSubject === 'string' ? parsed.commitSubject.trim() : '';
        const commitBody = typeof parsed.commitBody === 'string' ? parsed.commitBody.trim() : '';
        const prTitle = typeof parsed.prTitle === 'string' ? parsed.prTitle.trim() : '';
        const prBody = typeof parsed.prBody === 'string' ? parsed.prBody.trim() : '';
        if (!commitSubject || !prTitle || !prBody) {
            throw new Error('Submit JSON was missing required fields.');
        }
        return {
            commitSubject,
            commitBody: commitBody || 'Prepare local changes for submission.',
            prTitle,
            prBody,
        };
    }
    catch {
        return fallbackSubmitContent(repoRoot, diffRange, branch);
    }
}
function managedPrBody(generatedBody) {
    return [
        SUBMIT_BODY_START,
        generatedBody.trim(),
        SUBMIT_BODY_END,
    ].join('\n');
}
function mergePrBody(existingBody, generatedBody) {
    const nextManagedBody = managedPrBody(generatedBody);
    const start = existingBody.indexOf(SUBMIT_BODY_START);
    const end = existingBody.indexOf(SUBMIT_BODY_END);
    if (start !== -1 && end !== -1 && end > start) {
        return [
            existingBody.slice(0, start),
            nextManagedBody,
            existingBody.slice(end + SUBMIT_BODY_END.length),
        ].join('').trim();
    }
    if (existingBody.trim() === '') {
        return nextManagedBody;
    }
    return `${nextManagedBody}\n\n${existingBody.trim()}`;
}
function parsePrInfo(raw) {
    const value = JSON.parse(raw);
    if (typeof value.number !== 'number' || typeof value.url !== 'string') {
        fail('gh returned malformed pull request JSON.');
    }
    return {
        number: value.number,
        title: typeof value.title === 'string' ? value.title : '',
        body: typeof value.body === 'string' ? value.body : '',
        url: value.url,
    };
}
function currentPr(repoRoot) {
    const result = gh(['pr', 'view', '--json', 'number,title,body,url'], repoRoot, true);
    if (result.status !== 0) {
        return null;
    }
    return parsePrInfo(result.stdout);
}
function parseRepoInfo(raw) {
    const value = JSON.parse(raw);
    const owner = typeof value.owner?.login === 'string' ? value.owner.login : '';
    const name = typeof value.name === 'string' ? value.name : '';
    if (!owner || !name) {
        fail('gh returned malformed repository JSON.');
    }
    return { owner, name };
}
function currentRepo(repoRoot) {
    return parseRepoInfo(gh(['repo', 'view', '--json', 'owner,name'], repoRoot).stdout);
}
function parseGhPaginatedJson(raw) {
    const value = raw.trim() === '' ? [] : JSON.parse(raw);
    if (!Array.isArray(value)) {
        fail('gh api returned unexpected JSON.');
    }
    if (value.every((item) => Array.isArray(item))) {
        return value.flat();
    }
    return value;
}
function ghApiArray(repoRoot, endpoint) {
    const result = gh(['api', '--paginate', '--slurp', endpoint], repoRoot);
    return parseGhPaginatedJson(result.stdout);
}
function pushCurrentBranch(repoRoot, branch, remote) {
    const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], repoRoot, true);
    if (upstream.status === 0 && upstream.stdout.trim() !== '') {
        git(['push'], repoRoot);
        return;
    }
    git(['push', '-u', remote, branch], repoRoot);
}
function compactJson(value, maxBytes) {
    return truncateBytes(JSON.stringify(value, null, 2), maxBytes);
}
function commentsMarkdown(payload) {
    return [
        `PR: #${payload.pr.number} ${payload.pr.title}`,
        `URL: ${payload.pr.url}`,
        `Branch: ${payload.branch}`,
        '',
        'Issue comments:',
        compactJson(payload.issueComments, 30000),
        '',
        'Review comments:',
        compactJson(payload.reviewComments, 50000),
        '',
        'Reviews:',
        compactJson(payload.reviews, 30000),
    ].join('\n');
}
async function summarizePrComments(payload, options) {
    const maxBytes = Number.parseInt(process.env.DEV_LLM_MAX_COMMENTS_BYTES ?? '90000', 10);
    const commentsPayload = truncateBytes(JSON.stringify({
        pullRequest: payload.pr,
        repository: payload.repo,
        branch: payload.branch,
        changedFiles: payload.changedFiles,
        commitSubjects: payload.commitSubjects,
        issueComments: payload.issueComments,
        reviewComments: payload.reviewComments,
        reviews: payload.reviews,
    }, null, 2), maxBytes);
    const systemPrompt = [
        'You summarize GitHub pull request comments for an engineer.',
        'Identify comments that are still relevant and actionable for the current branch.',
        'Separate likely noise, praise, stale discussion, bot metadata, and already-addressed looking comments from actionable feedback.',
        'Prefer concrete file/path references when available.',
        'Do not invent comments or claim code was changed.',
        'Do not address the user as an assistant, offer follow-up work, or ask what to do next.',
        'Write like a CLI report, not a chat response.',
        'If you suggest a commit message or PR title, it must follow the same rules used by dev git submit.',
        ...conventionalCommitRules('Suggested commit subject'),
        'Return concise markdown with exactly these sections:',
        '## Actionable',
        '## Needs Judgment',
        '## Likely Noise',
        '## Suggested Next Steps',
        '## Suggested Commit',
    ].join('\n');
    const userPrompt = [
        `Repository: ${payload.repo.owner}/${payload.repo.name}`,
        `PR: #${payload.pr.number} ${payload.pr.title}`,
        `URL: ${payload.pr.url}`,
        `Branch: ${payload.branch}`,
        '',
        'Changed files:',
        payload.changedFiles || 'n/a',
        '',
        'Commit subjects:',
        payload.commitSubjects || 'n/a',
        '',
        'PR comments/reviews payload:',
        commentsPayload,
    ].join('\n');
    return stripMarkdownFence(await chat(systemPrompt, userPrompt, options)).trim();
}
async function summarizePrCommentsAgent(payload, options) {
    const maxBytes = Number.parseInt(process.env.DEV_LLM_MAX_COMMENTS_BYTES ?? '90000', 10);
    const commentsPayload = truncateBytes(JSON.stringify({
        pullRequest: payload.pr,
        repository: payload.repo,
        branch: payload.branch,
        changedFiles: payload.changedFiles,
        commitSubjects: payload.commitSubjects,
        issueComments: payload.issueComments,
        reviewComments: payload.reviewComments,
        reviews: payload.reviews,
    }, null, 2), maxBytes);
    const systemPrompt = [
        'You summarize GitHub pull request comments for a coding agent.',
        'Return valid JSON only. Do not include markdown fences or prose outside JSON.',
        'Use this exact top-level shape:',
        '{',
        '  "kind": "dev.git.comments",',
        '  "pr": { "number": number, "title": string, "url": string },',
        '  "branch": string,',
        '  "actionable": [{ "file": string|null, "line": number|null, "summary": string, "reason": string, "suggested_fix": string|null, "suggested_commit": string|null }],',
        '  "needs_judgment": [{ "summary": string, "reason": string }],',
        '  "likely_noise": [{ "summary": string, "reason": string }],',
        '  "suggested_next_steps": [string],',
        '  "suggested_commit": string|null',
        '}',
        'Identify comments that are still relevant and actionable for the current branch.',
        'Separate likely noise, praise, stale discussion, bot metadata, and already-addressed looking comments from actionable feedback.',
        'Prefer concrete file/path references when available.',
        'Do not invent comments or claim code was changed.',
        'Any suggested_commit value must follow the same rules used by dev git submit.',
        ...conventionalCommitRules('suggested_commit'),
    ].join('\n');
    const userPrompt = [
        `Repository: ${payload.repo.owner}/${payload.repo.name}`,
        `PR: #${payload.pr.number} ${payload.pr.title}`,
        `URL: ${payload.pr.url}`,
        `Branch: ${payload.branch}`,
        '',
        'Changed files:',
        payload.changedFiles || 'n/a',
        '',
        'Commit subjects:',
        payload.commitSubjects || 'n/a',
        '',
        'PR comments/reviews payload:',
        commentsPayload,
    ].join('\n');
    const raw = stripMarkdownFence(await chat(systemPrompt, userPrompt, options));
    try {
        return JSON.parse(raw);
    }
    catch {
        return {
            kind: 'dev.git.comments',
            pr: {
                number: payload.pr.number,
                title: payload.pr.title,
                url: payload.pr.url,
            },
            branch: payload.branch,
            actionable: [],
            needs_judgment: [{
                    summary: 'LLM returned non-JSON output while summarizing PR comments.',
                    reason: raw.trim(),
                }],
            likely_noise: [],
            suggested_next_steps: ['Inspect comments with dev git comments --raw.'],
            suggested_commit: null,
        };
    }
}
async function generateSquashCommitMessage(context, options) {
    const stat = gitOutput(['diff', '--shortstat', `${context.forkPoint}..HEAD`], context.repoRoot);
    const files = gitOutput(['diff', '--name-status', `${context.forkPoint}..HEAD`], context.repoRoot);
    const commits = gitOutput(['log', '--reverse', '--format=%s', `${context.forkPoint}..HEAD`], context.repoRoot);
    const diff = truncateBytes(gitOutput(['diff', '--no-ext-diff', '--minimal', `${context.forkPoint}..HEAD`], context.repoRoot), Number.parseInt(process.env.DEV_LLM_MAX_DIFF_BYTES ?? '40000', 10));
    const systemPrompt = [
        'You write concise git commit messages for engineers.',
        'Return valid JSON with exactly these keys: subject, body.',
        ...conventionalCommitRules('subject'),
        'The body must be concise plain text. Do not invent testing.',
    ].join('\n');
    const userPrompt = [
        `Repository: ${path.basename(context.repoRoot)}`,
        `Branch: ${context.branch}`,
        `Squashing ${context.commitCount} commits before rebasing onto ${context.target}.`,
        `Stats: ${stat || 'n/a'}`,
        '',
        'Commit subjects:',
        commits || 'n/a',
        '',
        'Files:',
        files || 'n/a',
        '',
        'Diff:',
        diff || 'n/a',
    ].join('\n');
    try {
        const raw = await chat(systemPrompt, userPrompt, options);
        const parsed = JSON.parse(stripMarkdownFence(raw));
        const subject = typeof parsed.subject === 'string' ? parsed.subject.trim() : '';
        const body = typeof parsed.body === 'string' ? parsed.body.trim() : '';
        if (!subject) {
            throw new Error('Commit message JSON did not include a subject.');
        }
        return {
            subject,
            body: body || 'Squash branch commits before rebasing onto the current upstream base.',
        };
    }
    catch {
        return fallbackCommitMessage(context.repoRoot, context.forkPoint);
    }
}
async function maybeSquash(context, options) {
    if (context.commitCount <= 1 || options.squashMode === 'never') {
        return false;
    }
    const shouldSquash = options.squashMode === 'always'
        ? true
        : await promptYesNo(`Squash ${context.commitCount} ${pluralize(context.commitCount, 'commit')} into one before rebasing?`, false);
    if (!shouldSquash) {
        return false;
    }
    const message = await step('Generating squash commit message', () => generateSquashCommitMessage(context, options));
    await step('Squashing branch commits', async () => {
        git(['reset', '--soft', context.forkPoint], context.repoRoot);
        git(['commit', '-m', message.subject, '-m', message.body], context.repoRoot);
    });
    return true;
}
function conflictedFiles(repoRoot) {
    return gitOutput(['diff', '--name-only', '--diff-filter=U'], repoRoot)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
}
async function isRebaseInProgress(repoRoot) {
    const mergePath = gitOutput(['rev-parse', '--git-path', 'rebase-merge'], repoRoot);
    const applyPath = gitOutput(['rev-parse', '--git-path', 'rebase-apply'], repoRoot);
    return await pathExists(mergePath) || await pathExists(applyPath);
}
async function resolveConflictFile(repoRoot, file, context, options) {
    const absolutePath = path.join(repoRoot, file);
    const content = await readFile(absolutePath, 'utf8');
    const maxBytes = Number.parseInt(process.env.DEV_LLM_MAX_CONFLICT_BYTES ?? '80000', 10);
    const byteLength = Buffer.byteLength(content, 'utf8');
    if (byteLength > maxBytes) {
        fail(`Conflict file is too large for automatic LLM resolution: ${file} (${byteLength} bytes).`);
    }
    const systemPrompt = [
        'You resolve git rebase conflicts.',
        'Return the complete resolved file content only.',
        'Do not include markdown fences, commentary, explanations, or conflict markers.',
        'Preserve the file style and intent from both sides when possible.',
    ].join('\n');
    const userPrompt = [
        `Repository: ${path.basename(repoRoot)}`,
        `File: ${file}`,
        `Current branch: ${context.branch}`,
        `Rebase target: ${context.target}`,
        '',
        'Resolve this conflicted file:',
        content,
    ].join('\n');
    const resolved = stripMarkdownFence(await chat(systemPrompt, userPrompt, options));
    if (resolved.includes('<<<<<<<') || resolved.includes('=======') || resolved.includes('>>>>>>>')) {
        fail(`LLM response still contained conflict markers for ${file}.`);
    }
    await writeFile(absolutePath, resolved.endsWith('\n') ? resolved : `${resolved}\n`, 'utf8');
    git(['add', file], repoRoot);
}
async function resolveConflicts(context, options) {
    while (await isRebaseInProgress(context.repoRoot)) {
        const files = conflictedFiles(context.repoRoot);
        if (files.length === 0) {
            const continued = gitRebaseContinue(context.repoRoot);
            if (continued.status === 0) {
                continue;
            }
            fail(clean(continued.stderr) || 'git rebase --continue failed.');
        }
        for (const file of files) {
            await step(`Resolving conflict in ${file}`, () => resolveConflictFile(context.repoRoot, file, context, options));
        }
        const continued = gitRebaseContinue(context.repoRoot);
        if (continued.status === 0) {
            continue;
        }
        if (conflictedFiles(context.repoRoot).length === 0) {
            fail(clean(continued.stderr) || 'git rebase --continue failed after resolving conflicts.');
        }
    }
}
export async function rebaseOntoOrigin(options) {
    const repoRoot = gitOutput(['rev-parse', '--show-toplevel']);
    const branch = currentBranch(repoRoot);
    ensureCleanWorktree(repoRoot);
    if (options.fetch) {
        await step(`Fetching ${options.remote}`, async () => {
            git(['fetch', options.remote, '--prune'], repoRoot);
        });
    }
    const baseBranch = options.baseBranch ?? resolveDefaultBranch(repoRoot, options.remote);
    const target = options.target ?? `${options.remote}/${baseBranch}`;
    const forkPoint = resolveForkPoint(repoRoot, target);
    const context = {
        repoRoot,
        branch,
        target,
        forkPoint,
        commitCount: commitCountSince(repoRoot, forkPoint),
    };
    if (context.commitCount === 0) {
        fail(`Branch ${branch} has no commits to rebase relative to ${target}.`);
    }
    const squashed = await maybeSquash(context, options);
    const rebase = await step(`Rebasing onto ${target}`, async () => git(['rebase', target], repoRoot, true));
    if (rebase.status !== 0) {
        if (!await isRebaseInProgress(repoRoot)) {
            fail(clean(rebase.stderr) || 'git rebase failed.');
        }
        if (!options.aiConflicts) {
            fail(clean(rebase.stderr) || 'Rebase stopped with conflicts.');
        }
        await resolveConflicts(context, options);
    }
    console.log('');
    printSection('Rebase Complete');
    printKeyValue('Branch', branch);
    printKeyValue('Target', target);
    printKeyValue('Squashed', squashed ? 'yes' : 'no');
}
export async function submitChanges(options) {
    const repoRoot = gitOutput(['rev-parse', '--show-toplevel']);
    const branch = currentBranch(repoRoot);
    const explicitBody = await readOptionalBody(options);
    if (options.fetch) {
        await maybeStep(options.agent, `Fetching ${options.remote}`, async () => {
            git(['fetch', options.remote, '--prune'], repoRoot);
        });
    }
    const baseBranch = options.baseBranch ?? resolveDefaultBranch(repoRoot, options.remote);
    const target = `${options.remote}/${baseBranch}`;
    if (branch === baseBranch) {
        fail(`Refusing to submit from ${branch}. Create a feature branch first.`);
    }
    if (hasUnstagedOrUntrackedChanges(repoRoot)) {
        if (options.agent && !options.yes) {
            printNeedsInput({
                kind: 'dev.needs_input',
                command: 'dev git submit',
                missing: ['--yes or a clean/staged working tree'],
                rerun: `dev git submit --agent --yes${options.title ? ` --title ${shellQuote(options.title)}` : ''}`,
            });
            return;
        }
        const shouldStageAll = options.agent
            ? options.yes
            : await promptYesNo('Stage all unstaged and untracked changes?', true);
        if (shouldStageAll) {
            await maybeStep(options.agent, 'Staging local changes', async () => {
                git(['add', '-A'], repoRoot);
            });
        }
    }
    let committed = false;
    let content = null;
    if (hasStagedChanges(repoRoot)) {
        const commitContent = options.title
            ? {
                commitSubject: options.title,
                commitBody: explicitBody || 'Prepare local changes for submission.',
                prTitle: options.title,
                prBody: explicitBody || '## Summary\n- Prepare local changes for submission.\n\n## Testing\n- Not run.',
            }
            : await maybeStep(options.agent, 'Preparing commit message', () => generateSubmitContent(repoRoot, branch, target, '--cached', options));
        await maybeStep(options.agent, 'Creating commit', async () => {
            git(['commit', '-m', commitContent.commitSubject, '-m', commitContent.commitBody], repoRoot);
        });
        committed = true;
    }
    const forkPoint = resolveForkPoint(repoRoot, target);
    const branchCommitCount = commitCountSince(repoRoot, forkPoint);
    if (branchCommitCount === 0) {
        fail('No local changes or branch commits to submit.');
    }
    content = await maybeStep(options.agent, 'Preparing pull request content', async () => {
        if (options.title) {
            return {
                commitSubject: options.title,
                commitBody: explicitBody || 'Prepare local changes for submission.',
                prTitle: options.title,
                prBody: explicitBody || '## Summary\n- Prepare local changes for submission.\n\n## Testing\n- Not run.',
            };
        }
        const generated = await generateSubmitContent(repoRoot, branch, target, `${target}...HEAD`, options);
        return {
            ...generated,
            commitSubject: generated.commitSubject,
            commitBody: explicitBody || generated.commitBody,
            prTitle: generated.prTitle,
            prBody: explicitBody || generated.prBody,
        };
    });
    await maybeStep(options.agent, `Pushing ${branch}`, async () => {
        pushCurrentBranch(repoRoot, branch, options.remote);
    });
    const existingPr = await maybeStep(options.agent, 'Checking pull request', async () => currentPr(repoRoot));
    let pr;
    if (existingPr) {
        const body = mergePrBody(existingPr.body, content.prBody);
        await maybeStep(options.agent, `#${existingPr.number} Updating pull request`, async () => {
            gh(['pr', 'edit', String(existingPr.number), '--title', content.prTitle, '--body', body], repoRoot);
        });
        pr = {
            ...existingPr,
            title: content.prTitle,
            body,
        };
    }
    else {
        const args = [
            'pr',
            'create',
            '--base',
            baseBranch,
            '--head',
            branch,
            '--title',
            content.prTitle,
            '--body',
            managedPrBody(content.prBody),
        ];
        if (options.draft) {
            args.push('--draft');
        }
        const created = await maybeStep(options.agent, 'Creating pull request', async () => gh(args, repoRoot));
        const url = created.stdout.trim();
        const viewed = currentPr(repoRoot);
        pr = viewed ?? {
            number: 0,
            title: content.prTitle,
            body: managedPrBody(content.prBody),
            url,
        };
    }
    if (options.agent) {
        printJson({
            kind: 'dev.git.submit',
            branch,
            base: baseBranch,
            commit: committed ? 'created' : 'none',
            pr: {
                number: pr.number,
                title: pr.title,
                url: pr.url,
            },
            title: content.prTitle,
        });
        return;
    }
    console.log('');
    printSection('Submit Complete');
    printKeyValue('Branch', branch);
    printKeyValue('Base', baseBranch);
    printKeyValue('Commit', committed ? 'created' : 'none');
    printKeyValue('PR', pr.url);
}
export async function summarizeComments(options) {
    const repoRoot = gitOutput(['rev-parse', '--show-toplevel']);
    const branch = currentBranch(repoRoot);
    const pr = await maybeStep(options.agent, 'Finding current pull request', async () => currentPr(repoRoot));
    if (!pr) {
        fail('No pull request found for the current branch.');
    }
    const repo = await maybeStep(options.agent, 'Reading GitHub repository', async () => currentRepo(repoRoot));
    const encodedRepo = `${repo.owner}/${repo.name}`;
    const issueCommentsEndpoint = `repos/${encodedRepo}/issues/${pr.number}/comments?per_page=100`;
    const reviewCommentsEndpoint = `repos/${encodedRepo}/pulls/${pr.number}/comments?per_page=100`;
    const reviewsEndpoint = `repos/${encodedRepo}/pulls/${pr.number}/reviews?per_page=100`;
    const issueComments = await maybeStep(options.agent, 'Fetching issue comments', async () => ghApiArray(repoRoot, issueCommentsEndpoint));
    const reviewComments = await maybeStep(options.agent, 'Fetching review comments', async () => ghApiArray(repoRoot, reviewCommentsEndpoint));
    const reviews = await maybeStep(options.agent, 'Fetching reviews', async () => ghApiArray(repoRoot, reviewsEndpoint));
    const changedFiles = gh(['pr', 'diff', '--name-only'], repoRoot, true).stdout.trim();
    const commitSubjects = gh(['pr', 'view', '--json', 'commits', '--jq', '.commits[].messageHeadline'], repoRoot, true)
        .stdout
        .trim();
    const payload = {
        pr,
        repo,
        branch,
        changedFiles,
        commitSubjects,
        issueComments,
        reviewComments,
        reviews,
    };
    if (options.agent) {
        const totalComments = issueComments.length + reviewComments.length + reviews.length;
        if (totalComments === 0) {
            printJson({
                kind: 'dev.git.comments',
                pr: {
                    number: pr.number,
                    title: pr.title,
                    url: pr.url,
                },
                branch,
                actionable: [],
                needs_judgment: [],
                likely_noise: [],
                suggested_next_steps: [],
                suggested_commit: null,
            });
            return;
        }
        printJson(await summarizePrCommentsAgent(payload, options));
        return;
    }
    console.log('');
    printSection('Pull Request Comments');
    printKeyValue('PR', `#${pr.number}`);
    printKeyValue('URL', pr.url);
    printKeyValue('Issue', String(issueComments.length));
    printKeyValue('Review', String(reviewComments.length));
    printKeyValue('Reviews', String(reviews.length));
    if (options.raw) {
        console.log('');
        console.log(commentsMarkdown(payload));
        return;
    }
    const totalComments = issueComments.length + reviewComments.length + reviews.length;
    if (totalComments === 0) {
        console.log('');
        console.log('No comments or reviews found for this PR.');
        return;
    }
    const summary = await step('Summarizing comments with LLM', () => summarizePrComments(payload, options));
    console.log('');
    console.log(summary);
}
