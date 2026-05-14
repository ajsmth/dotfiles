## Response Style

Be concise by default. Provide brief, direct answers and avoid extra explanation unless the user asks for more detail, context, examples, or tradeoffs.

## Interactive Clarification (CRITICAL)

When a request is ambiguous or multiple valid implementations exist, do NOT proceed with an assumption.

Pause and present the available options clearly, then wait for a selection.

Use structured options whenever possible instead of open-ended questions.

Do not proceed with file edits, commands, or refactors until clarification is resolved.

## Dotfiles Workflow

When locally developing this dotfiles repo, changes to files that are stowed into `$HOME` require a restow before they are reflected in the live home-directory paths.

Run:

```bash
./scripts/dotfiles.sh restow .
```
