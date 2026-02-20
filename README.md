# Dotfiles

Cross-platform dotfiles setup for macOS and Linux using GNU Stow.

## Structure

- Dotfiles live at repo root and are stowed as package `.`
  - `./.zshrc -> ~/.zshrc`
  - `./.tmux.conf -> ~/.tmux.conf`
  - `./.config/nvim -> ~/.config/nvim`
  - `./.config/ghostty -> ~/.config/ghostty`
- `scripts/bootstrap.sh`: installs prerequisites (`stow`, package manager deps)
- `scripts/dotfiles.sh`: stow wrapper for linking/unlinking/adopting configs
- `scripts/setup.sh`: one-shot bootstrap + stow

## Quick start

```bash
git clone https://github.com/ajsmth/dotfiles.git ~/dotfiles
cd ~/dotfiles
./scripts/setup.sh
```

## Common commands

```bash
# Preview changes without writing files
./scripts/dotfiles.sh dry-run .

# Link/re-link files into $HOME
./scripts/dotfiles.sh restow .

# Remove links
./scripts/dotfiles.sh unlink .

# Adopt existing files from $HOME into the repo package
./scripts/dotfiles.sh adopt .
```

## Iteration workflow

1. Edit files at repo root (for example `./.zshrc`, `./.config/nvim/...`).
2. Re-apply links with `./scripts/dotfiles.sh restow .`.
3. Commit changes and push.

## Notes

- `scripts/bootstrap.sh` supports `brew` on macOS and `apt`/`dnf`/`pacman` on Linux.
- Existing dotfiles in `$HOME` can conflict on first run; use `dry-run` and `adopt` as needed.
