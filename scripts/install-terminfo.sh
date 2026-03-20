#!/usr/bin/env bash
set -euo pipefail

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TERMINFO_SOURCE="$DOTFILES_DIR/terminfo/xterm-ghostty.src"

usage() {
  cat <<'USAGE'
Usage:
  install-terminfo.sh
  install-terminfo.sh local
  install-terminfo.sh remote <ssh-target>

Examples:
  ./scripts/install-terminfo.sh
  ./scripts/install-terminfo.sh local
  ./scripts/install-terminfo.sh remote andy@192.168.1.75
  ./scripts/install-terminfo.sh remote devbox
USAGE
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

install_local() {
  require_cmd tic
  mkdir -p "$HOME/.terminfo"
  tic -x -o "$HOME/.terminfo" "$TERMINFO_SOURCE"
  infocmp -x xterm-ghostty >/dev/null
  printf 'Installed xterm-ghostty terminfo into %s/.terminfo\n' "$HOME"
}

install_remote() {
  local target="$1"
  local remote_source="/tmp/xterm-ghostty.src"

  require_cmd scp
  require_cmd ssh

  scp "$TERMINFO_SOURCE" "${target}:${remote_source}"
  ssh "$target" "mkdir -p ~/.terminfo && tic -x -o ~/.terminfo $remote_source && infocmp -x xterm-ghostty >/dev/null"
  printf 'Installed xterm-ghostty terminfo on %s\n' "$target"
}

main() {
  local mode="${1:-local}"

  case "$mode" in
    local)
      install_local
      ;;
    remote)
      if [[ $# -ne 2 ]]; then
        usage >&2
        exit 1
      fi
      install_remote "$2"
      ;;
    -h|--help)
      usage
      ;;
    *)
      usage >&2
      exit 1
      ;;
  esac
}

main "$@"
