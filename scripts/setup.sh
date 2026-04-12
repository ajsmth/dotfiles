#!/usr/bin/env bash
set -euo pipefail

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"$DOTFILES_DIR/scripts/bootstrap.sh"

mkdir -p "$HOME/.codex"
mkdir -p "$HOME/.pi/agent/extensions"
mkdir -p "$HOME/.pi/agent/themes"

"$DOTFILES_DIR/scripts/dotfiles.sh" restow .

# Codex keeps mutable state in ~/.codex, so only link the shared instruction file.
ln -sf "$DOTFILES_DIR/.codex/AGENTS.md" "$HOME/.codex/AGENTS.md"

"$DOTFILES_DIR/scripts/install-terminfo.sh"
"$DOTFILES_DIR/scripts/install-fonts.sh"

echo 'Setup complete. Restart your shell to pick up changes.'
