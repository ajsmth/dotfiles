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

install_linux_packages() {
  local packages=(stow git curl)

  if has_cmd apt-get; then
    run_privileged apt-get update
    run_privileged apt-get install -y "${packages[@]}"
    return
  fi

  if has_cmd dnf; then
    run_privileged dnf install -y "${packages[@]}"
    return
  fi

  if has_cmd pacman; then
    run_privileged pacman -Syu --noconfirm "${packages[@]}"
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
          brew install stow git tmux neovim
        fi
      else
        log 'Installing minimum packages via Homebrew.'
        brew install stow git tmux neovim
      fi
      ;;
    Linux)
      install_linux_packages
      ;;
    *)
      log "Unsupported OS: $OS"
      exit 1
      ;;
  esac

  log 'Bootstrap complete.'
}

main "$@"
