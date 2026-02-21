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
- `scripts/install-fonts.sh`: installs fonts from `fonts/` into user font dirs
- `scripts/setup.sh`: one-shot bootstrap + stow

## Quick start

```bash
git clone https://github.com/ajsmth/dotfiles.git ~/dotfiles
cd ~/dotfiles
./scripts/setup.sh
```

## Fonts

1. Add font files to `fonts/` (`.ttf`, `.otf`, `.ttc`, `.woff`, `.woff2`).
2. Install with `./scripts/install-fonts.sh` (or just run `./scripts/setup.sh`).

Install targets:

- macOS: `~/Library/Fonts`
- Linux: `~/.local/share/fonts` (then cache refresh via `fc-cache` when available)

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
- On macOS, bootstrap installs: `git`, `stow`, `tmux`, `neovim`, `pure`, `nvm`, `rbenv`, `lazygit`, `ripgrep`, `fd`, `fzf`, `zoxide`, `ghostty`.
- `bun` is installed via the official install script when missing.
- `nvm` is installed from Homebrew when available; bootstrap falls back to `~/.nvm` git install if needed.
- On Linux, Ghostty install is attempted via distro package manager (`pacman`/`apk`/`zypper`/`snap`) when available.
- `zsh-z` is installed via git clone to `~/zsh-z` (used by `.zshrc`).
- Android SDK/Java paths in `.zshrc` are user-specific and are not installed by bootstrap.
- Bootstrap verifies required shell tooling (`rbenv`, `nvm`, `bun`) and exits clearly if anything is still missing.
- Existing dotfiles in `$HOME` can conflict on first run; use `dry-run` and `adopt` as needed.
