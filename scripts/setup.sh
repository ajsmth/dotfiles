#!/usr/bin/env bash
set -euo pipefail

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"$DOTFILES_DIR/scripts/bootstrap.sh"
"$DOTFILES_DIR/scripts/dotfiles.sh" restow .

# Stow can't fold dirs that already exist — link these manually
mkdir -p "$HOME/.codex"
ln -sf "$DOTFILES_DIR/.codex/AGENTS.md" "$HOME/.codex/AGENTS.md"

"$DOTFILES_DIR/scripts/install-fonts.sh"

echo 'Setup complete. Restart your shell to pick up changes.'
