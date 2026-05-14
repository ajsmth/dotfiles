#!/usr/bin/env bash
set -euo pipefail

REPO="${1:-withremyinc/remy-ts}"
PR="${2:-1391}"

echo "== PR METADATA =="
gh pr view "https://github.com/$REPO/pull/$PR" \
  --json number,url,title,headRefName,baseRefName,isDraft,author

echo
echo "== ISSUE COMMENTS (timeline comments / anchors) =="
gh api "repos/$REPO/issues/$PR/comments?per_page=100" | jq -r '
  sort_by(.created_at)[] |
  "-----\n" +
  "id: \(.id)\n" +
  "author: \(.user.login)\n" +
  "created_at: \(.created_at)\n" +
  "updated_at: \(.updated_at)\n" +
  "url: \(.html_url)\n" +
  "body:\n\(.body)\n"
'

echo
echo "== REVIEW COMMENTS (inline/file comments) =="
gh api "repos/$REPO/pulls/$PR/comments?per_page=100" | jq -r '
  sort_by(.created_at)[] |
  "-----\n" +
  "id: \(.id)\n" +
  "author: \(.user.login)\n" +
  "created_at: \(.created_at)\n" +
  "updated_at: \(.updated_at)\n" +
  "path: \(.path // "")\n" +
  "line: \((.line // .original_line // "")|tostring)\n" +
  "url: \(.html_url)\n" +
  "body:\n\(.body)\n"
'

echo
echo "== REVIEWS (top-level review summaries / approve/request changes) =="
gh api "repos/$REPO/pulls/$PR/reviews?per_page=100" | jq -r '
  sort_by(.submitted_at)[] |
  "-----\n" +
  "id: \(.id)\n" +
  "author: \(.user.login)\n" +
  "state: \(.state)\n" +
  "submitted_at: \(.submitted_at)\n" +
  "url: \(.html_url)\n" +
  "body:\n\(.body // "")\n"
'

echo
echo "== BOT-ONLY VIEW (quick sanity check) =="
{
  echo "--- issue comments ---"
  gh api "repos/$REPO/issues/$PR/comments?per_page=100" | jq -r '
    sort_by(.created_at)[]
    | select((.user.login | test("coderabbit|codex|openai|copilot|github-actions"; "i")) or (.body | test("gpt|code review by gpt|coderabbit|actionable comments posted|duplicate comments"; "i")))
    | "id=\(.id) author=\(.user.login) created=\(.created_at)\n\(.body)\n"
  '

  echo "--- review comments ---"
  gh api "repos/$REPO/pulls/$PR/comments?per_page=100" | jq -r '
    sort_by(.created_at)[]
    | select((.user.login | test("coderabbit|codex|openai|copilot|github-actions"; "i")) or (.body | test("gpt|code review by gpt|coderabbit|actionable comments posted|duplicate comments"; "i")))
    | "id=\(.id) author=\(.user.login) created=\(.created_at) path=\(.path // "") line=\((.line // .original_line // "")|tostring)\n\(.body)\n"
  '

  echo "--- reviews ---"
  gh api "repos/$REPO/pulls/$PR/reviews?per_page=100" | jq -r '
    sort_by(.submitted_at)[]
    | select((.user.login | test("coderabbit|codex|openai|copilot|github-actions"; "i")) or ((.body // "") | test("gpt|code review by gpt|coderabbit|actionable comments posted|duplicate comments"; "i")))
    | "id=\(.id) author=\(.user.login) state=\(.state) submitted=\(.submitted_at)\n\(.body // "")\n"
  '
}

echo
echo "== LOCAL PI SNAPSHOTS FOR PR $PR =="
if [ -d "$HOME/.local/state/pi/reviews" ]; then
  find "$HOME/.local/state/pi/reviews" -type f | grep "pr-$PR" | sort || true
else
  echo "No ~/.local/state/pi/reviews directory found"
fi

echo
echo "== LOCAL PI SNAPSHOT CONTENTS =="
if [ -d "$HOME/.local/state/pi/reviews" ]; then
  find "$HOME/.local/state/pi/reviews" -type f | grep "pr-$PR" | sort | while read -r file; do
    echo "----- FILE: $file"
    cat "$file"
    echo
  done
fi
