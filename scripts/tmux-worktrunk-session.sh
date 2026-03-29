#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  tmux-worktrunk-session.sh list
  tmux-worktrunk-session.sh switch [wt-switch-args...]
  tmux-worktrunk-session.sh create <branch> [wt-switch-args...]
  tmux-worktrunk-session.sh create-prompt
  tmux-worktrunk-session.sh delete <branch>

Modes:
  list    Print tab-separated worktree rows for the Television channel.
  switch  Open Worktrunk's picker or switch to the provided branch, then jump to the tmux session with sesh.
  create  Create a new worktree for the provided branch, then jump to the tmux session with sesh.
  create-prompt  Prompt for a new branch name, then create a worktree and jump to its tmux session.
  delete  Remove the provided worktree with Worktrunk's safe defaults.
EOF
}

hold_on_error() {
  local status="$1"
  printf '\n[tmux-worktrunk-session] command failed (exit %s)\nPress Enter to close...' "$status" >&2
  read -r _
  exit "$status"
}

trim_whitespace() {
  local value="${1:-}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

run_wt() {
  local -a cmd=(
    wt
    switch
    --no-cd
    -x
    "sesh connect --switch {{ worktree_path }}"
  )

  cmd+=("$@")

  if ! "${cmd[@]}"; then
    hold_on_error "$?"
  fi
}

run_wt_picker() {
  local branch

  if ! branch="$(wt switch --no-cd "$@")"; then
    hold_on_error "$?"
  fi

  branch="$(trim_whitespace "${branch##*$'\n'}")"

  if [[ -z "$branch" ]]; then
    exit 0
  fi

  run_wt "$branch"
}

resolve_worktree_path() {
  local branch="$1"

  git worktree list --porcelain | awk -v branch="refs/heads/$branch" '
    $1 == "worktree" { path = $2 }
    $1 == "branch" && $2 == branch { print path; exit }
  '
}

create_worktree() {
  local branch="$1"

  if ! wt switch --create --no-cd "$branch"; then
    hold_on_error "$?"
  fi
}

copy_tracked_changes() {
  local target_path="$1"
  local staged_patch unstaged_patch

  staged_patch="$(mktemp)"
  unstaged_patch="$(mktemp)"
  trap 'rm -f "$staged_patch" "$unstaged_patch"' RETURN

  git diff --cached --binary >"$staged_patch"
  git diff --binary >"$unstaged_patch"

  if [[ -s "$staged_patch" ]]; then
    git -C "$target_path" apply --cached --whitespace=nowarn "$staged_patch"
  fi

  if [[ -s "$unstaged_patch" ]]; then
    git -C "$target_path" apply --whitespace=nowarn "$unstaged_patch"
  fi
}

copy_untracked_files() {
  local target_path="$1"

  while IFS= read -r -d '' relpath; do
    mkdir -p "$target_path/$(dirname "$relpath")"
    cp -pR "$relpath" "$target_path/$relpath"
  done < <(git ls-files --others --exclude-standard -z)
}

connect_worktree() {
  local target_path="$1"

  if ! sesh connect --switch "$target_path"; then
    hold_on_error "$?"
  fi
}

create_with_mode() {
  local branch="$1"
  local copy_mode="$2"
  local target_path

  create_worktree "$branch"
  target_path="$(resolve_worktree_path "$branch")"
  target_path="$(trim_whitespace "$target_path")"

  if [[ -z "$target_path" ]]; then
    printf '\n[tmux-worktrunk-session] could not resolve worktree path for %s\nPress Enter to close...' "$branch" >&2
    read -r _
    exit 1
  fi

  case "$copy_mode" in
    tracked)
      copy_tracked_changes "$target_path"
      ;;
    full)
      copy_tracked_changes "$target_path"
      copy_untracked_files "$target_path"
      ;;
    clean)
      ;;
    *)
      printf '\n[tmux-worktrunk-session] unknown copy mode: %s\nPress Enter to close...' "$copy_mode" >&2
      read -r _
      exit 1
      ;;
  esac

  connect_worktree "$target_path"
}

list_worktrees() {
  wt list | awk '
function trim(s) {
  sub(/^[[:space:]]+/, "", s)
  sub(/[[:space:]]+$/, "", s)
  return s
}

NR == 1 { next }

{
  gsub(/\033\[[0-9;]*m/, "")

  line = trim($0)
  if (line == "" || line ~ /^○ /) {
    next
  }

  marker = substr(line, 1, 1)
  if (marker == "@" || marker == "+" || marker == "^") {
    line = trim(substr(line, 2))
  } else {
    marker = ""
  }

  count = split(line, cols, /[[:space:]][[:space:]]+/)
  if (count < 5) {
    next
  }

  branch = cols[1]
  status = cols[2]
  path = cols[count - 3]
  age = cols[count - 1]
  message = cols[count]

  current = (marker == "@") ? "*" : " "
  printf "%s\t%s\t%s\t%s\t%s\n", branch, current, path, status, age "  " message
}'
}

prompt_for_branch() {
  local branch
  local copy_mode choice

  printf 'New worktree branch: ' >&2
  read -r branch
  branch="$(trim_whitespace "$branch")"

  if [[ -z "$branch" ]]; then
    exit 0
  fi

  cat >&2 <<'EOF'
Copy changes:
  1) clean
  2) tracked changes only
  3) tracked + untracked files
Choice [1/2/3]:
EOF
  read -r choice
  choice="$(trim_whitespace "$choice")"

  case "$choice" in
    ""|1)
      copy_mode="clean"
      ;;
    2)
      copy_mode="tracked"
      ;;
    3)
      copy_mode="full"
      ;;
    *)
      exit 0
      ;;
  esac

  create_with_mode "$branch" "$copy_mode"
}

delete_worktree() {
  local branch="$1"

  if ! wt remove --foreground "$branch"; then
    hold_on_error "$?"
  fi
}

mode="${1:-}"
if [[ -z "$mode" ]]; then
  usage
  exit 1
fi
shift

case "$mode" in
  list)
    list_worktrees
    ;;
  switch)
    if [[ $# -eq 0 ]]; then
      run_wt_picker
    else
      run_wt "$@"
    fi
    ;;
  create)
    if [[ $# -lt 1 ]]; then
      usage
      exit 1
    fi

    branch="$1"
    shift
    run_wt --create "$branch" "$@"
    ;;
  create-prompt)
    prompt_for_branch
    ;;
  delete)
    if [[ $# -lt 1 ]]; then
      usage
      exit 1
    fi

    delete_worktree "$1"
    ;;
  *)
    usage
    exit 1
    ;;
esac
