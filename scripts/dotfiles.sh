#!/usr/bin/env bash
set -euo pipefail

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${DOTFILES_TARGET:-$HOME}"
DEFAULT_PACKAGES=(.)

usage() {
  cat <<USAGE
Usage: $(basename "$0") <action> [package ...]

Actions:
  link      Link package(s) into target (default action)
  restow    Re-link package(s) (stow -R)
  unlink    Remove links for package(s) (stow -D)
  adopt     Move existing target files into repo, then link (stow --adopt)
  dry-run   Preview link changes (stow -n)

Environment:
  DOTFILES_TARGET   Target directory for symlinks (default: \$HOME)

Examples:
  $(basename "$0") link .
  $(basename "$0") dry-run .
  $(basename "$0") adopt .
USAGE
}

ensure_stow() {
  if ! command -v stow >/dev/null 2>&1; then
    echo 'stow is required. Run scripts/bootstrap.sh first.' >&2
    exit 1
  fi
}

main() {
  local action="${1:-link}"
  if [[ "$action" == "-h" || "$action" == "--help" ]]; then
    usage
    exit 0
  fi

  shift || true
  local -a packages
  if [[ $# -gt 0 ]]; then
    packages=("$@")
  else
    packages=("${DEFAULT_PACKAGES[@]}")
  fi

  ensure_stow

  local -a base=(stow --verbose --target "$TARGET_DIR" --dir "$DOTFILES_DIR")

  case "$action" in
    link)
      "${base[@]}" "${packages[@]}"
      ;;
    restow)
      "${base[@]}" -R "${packages[@]}"
      ;;
    unlink)
      "${base[@]}" -D "${packages[@]}"
      ;;
    adopt)
      "${base[@]}" --adopt -R "${packages[@]}"
      ;;
    dry-run)
      "${base[@]}" -n -R "${packages[@]}"
      ;;
    *)
      echo "Unknown action: $action" >&2
      usage
      exit 1
      ;;
  esac
}

main "$@"
