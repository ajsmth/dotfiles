#!/usr/bin/env bash
set -euo pipefail

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OS="$(uname -s)"

log() {
  printf '[bootstrap] %s\n' "$*"
}

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

has_bun() {
  has_cmd bun || [[ -x "$HOME/.bun/bin/bun" ]]
}

run_privileged() {
  if [[ ${EUID:-$(id -u)} -eq 0 ]]; then
    "$@"
  elif has_cmd sudo; then
    sudo "$@"
  else
    "$@"
  fi
}

ensure_homebrew() {
  if has_cmd brew; then
    return
  fi

  log 'Homebrew not found, installing.'
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
}

install_zsh_z() {
  local target_dir="$HOME/zsh-z"
  if [[ -f "$target_dir/zsh-z.plugin.zsh" ]]; then
    return
  fi

  if has_cmd git; then
    log 'Installing zsh-z plugin into ~/zsh-z.'
    git clone https://github.com/agkozak/zsh-z.git "$target_dir"
  else
    log 'git not found; skipping zsh-z install.'
  fi
}

install_nvm() {
  local nvm_dir="$HOME/.nvm"
  if [[ -s "$nvm_dir/nvm.sh" ]]; then
    return
  fi

  if has_cmd brew; then
    # Homebrew installs nvm under its prefix; .zshrc handles sourcing it.
    if [[ -s "$(brew --prefix nvm 2>/dev/null)/nvm.sh" ]]; then
      return
    fi
  fi

  if has_cmd git; then
    log 'Installing nvm into ~/.nvm.'
    if [[ -d "$nvm_dir/.git" ]]; then
      (
        cd "$nvm_dir"
        git fetch --tags
        git checkout "$(git describe --abbrev=0 --tags)"
      )
    elif [[ -e "$nvm_dir" ]]; then
      log "~/.nvm exists but is not an nvm git checkout; skipping auto-install."
    else
      git clone https://github.com/nvm-sh/nvm.git "$nvm_dir"
      (
        cd "$nvm_dir"
        git checkout "$(git describe --abbrev=0 --tags)"
      )
    fi
  else
    log 'git not found; skipping nvm install.'
  fi
}

install_bun() {
  if has_bun; then
    return
  fi

  if has_cmd curl; then
    log 'Installing bun via official install script.'
    curl -fsSL https://bun.sh/install | bash
  else
    log 'curl not found; skipping bun install.'
  fi
}

install_fzf_shell_integration() {
  if has_cmd brew; then
    local fzf_install_script
    fzf_install_script="$(brew --prefix)/opt/fzf/install"
    if [[ -x "$fzf_install_script" ]]; then
      "$fzf_install_script" --key-bindings --completion --no-update-rc >/dev/null 2>&1 || true
      return
    fi
  fi
}

install_ghostty() {
  if has_cmd ghostty; then
    return
  fi

  case "$OS" in
    Darwin)
      if has_cmd brew; then
        log 'Installing Ghostty via Homebrew cask.'
        brew install --cask ghostty || log 'Ghostty install failed; continuing.'
      fi
      ;;
    Linux)
      if has_cmd pacman; then
        log 'Installing Ghostty via pacman.'
        run_privileged pacman -S --noconfirm ghostty || log 'Ghostty install failed; continuing.'
      elif has_cmd apk; then
        log 'Installing Ghostty via apk.'
        run_privileged apk add ghostty || log 'Ghostty install failed; continuing.'
      elif has_cmd zypper; then
        log 'Installing Ghostty via zypper.'
        run_privileged zypper --non-interactive install ghostty || log 'Ghostty install failed; continuing.'
      elif has_cmd snap; then
        log 'Installing Ghostty via snap.'
        run_privileged snap install ghostty --classic || log 'Ghostty install failed; continuing.'
      else
        log 'No supported Ghostty package manager found; install manually from ghostty.org docs.'
      fi
      ;;
  esac
}

verify_requirements() {
  local -a missing=()

  if ! has_cmd rbenv; then
    missing+=("rbenv")
  fi

  if ! has_bun; then
    missing+=("bun")
  fi

  if [[ ! -s "$HOME/.nvm/nvm.sh" ]]; then
    if has_cmd brew; then
      if [[ ! -s "$(brew --prefix nvm 2>/dev/null)/nvm.sh" ]]; then
        missing+=("nvm")
      fi
    else
      missing+=("nvm")
    fi
  fi

  if [[ ${#missing[@]} -gt 0 ]]; then
    log "Missing required tooling after bootstrap: ${missing[*]}"
    log 'Please install the missing tools, then rerun scripts/setup.sh.'
    exit 1
  fi
}

install_linux_packages() {
  if has_cmd apt-get; then
    run_privileged apt-get update
    run_privileged apt-get install -y stow git curl ripgrep fd-find fzf zoxide
    return
  fi

  if has_cmd dnf; then
    run_privileged dnf install -y stow git curl ripgrep fd-find fzf zoxide
    return
  fi

  if has_cmd pacman; then
    run_privileged pacman -Syu --noconfirm stow git curl ripgrep fd fzf zoxide
    return
  fi

  log 'No supported Linux package manager found (apt, dnf, pacman). Install stow manually.'
}

main() {
  case "$OS" in
    Darwin)
      ensure_homebrew
      if [[ -f "$DOTFILES_DIR/Brewfile" ]]; then
        log 'Installing packages from Brewfile.'
        if ! brew bundle --file "$DOTFILES_DIR/Brewfile"; then
          log 'brew bundle failed, falling back to minimum install.'
          brew install stow git tmux neovim pure nvm rbenv lazygit ripgrep fd fzf zoxide
        fi
      else
        log 'Installing minimum packages via Homebrew.'
        brew install stow git tmux neovim pure nvm rbenv lazygit ripgrep fd fzf zoxide
      fi
      install_nvm
      install_bun
      install_fzf_shell_integration
      install_ghostty
      install_zsh_z
      ;;
    Linux)
      install_linux_packages
      install_nvm
      install_bun
      install_fzf_shell_integration
      install_ghostty
      install_zsh_z
      ;;
    *)
      log "Unsupported OS: $OS"
      exit 1
      ;;
  esac

  verify_requirements

  log 'Bootstrap complete.'
}

main "$@"
