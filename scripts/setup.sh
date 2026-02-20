#!/usr/bin/env bash
set -euo pipefail

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"$DOTFILES_DIR/scripts/bootstrap.sh"
"$DOTFILES_DIR/scripts/dotfiles.sh" restow .
"$DOTFILES_DIR/scripts/install-fonts.sh"

echo 'Setup complete. Restart your shell to pick up changes.'
