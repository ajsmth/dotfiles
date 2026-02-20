#!/usr/bin/env bash
set -euo pipefail

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FONTS_SRC_DIR="$DOTFILES_DIR/fonts"
OS="$(uname -s)"

log() {
  printf '[fonts] %s\n' "$*"
}

find_font_files() {
  if [[ ! -d "$FONTS_SRC_DIR" ]]; then
    return
  fi

  find "$FONTS_SRC_DIR" -type f \( \
    -iname '*.ttf' -o \
    -iname '*.otf' -o \
    -iname '*.ttc' -o \
    -iname '*.woff' -o \
    -iname '*.woff2' \
  \)
}

install_fonts() {
  local dest_dir="$1"
  mkdir -p "$dest_dir"

  local installed_count=0
  while IFS= read -r src_file; do
    [[ -z "$src_file" ]] && continue
    local rel_path dest_file
    rel_path="${src_file#"$FONTS_SRC_DIR"/}"
    dest_file="$dest_dir/$rel_path"

    mkdir -p "$(dirname "$dest_file")"
    cp -f "$src_file" "$dest_file"
    installed_count=$((installed_count + 1))
  done < <(find_font_files)

  if [[ $installed_count -eq 0 ]]; then
    log "No font files found in $FONTS_SRC_DIR"
  else
    log "Installed $installed_count font file(s) to $dest_dir"
  fi
}

refresh_cache() {
  if command -v fc-cache >/dev/null 2>&1; then
    fc-cache -f "$1" >/dev/null 2>&1 || fc-cache -f >/dev/null 2>&1 || true
    log 'Refreshed font cache.'
  fi
}

main() {
  case "$OS" in
    Darwin)
      install_fonts "$HOME/Library/Fonts"
      ;;
    Linux)
      install_fonts "$HOME/.local/share/fonts"
      refresh_cache "$HOME/.local/share/fonts"
      ;;
    *)
      log "Unsupported OS: $OS"
      exit 1
      ;;
  esac
}

main "$@"
