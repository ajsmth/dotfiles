
if [[ -x /opt/homebrew/bin/brew ]]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif [[ -x /usr/local/bin/brew ]]; then
  eval "$(/usr/local/bin/brew shellenv)"
fi

if command -v brew >/dev/null 2>&1; then
  fpath+=("$(brew --prefix)/share/zsh/site-functions")
fi

autoload -U promptinit
promptinit
if prompt -l | grep -qw pure; then
  prompt pure
fi

if command -v rbenv >/dev/null 2>&1; then
  eval "$(rbenv init - --no-rehash zsh)"
fi

export NVM_DIR="$HOME/.nvm"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  . "$NVM_DIR/nvm.sh"
elif command -v brew >/dev/null 2>&1; then
  NVM_BREW_PREFIX="$(brew --prefix nvm 2>/dev/null || true)"
  if [[ -n "$NVM_BREW_PREFIX" && -s "$NVM_BREW_PREFIX/nvm.sh" ]]; then
    . "$NVM_BREW_PREFIX/nvm.sh"
  fi
fi

if [[ -s "$NVM_DIR/bash_completion" ]]; then
  . "$NVM_DIR/bash_completion"
elif [[ -n "${NVM_BREW_PREFIX:-}" && -s "$NVM_BREW_PREFIX/etc/bash_completion.d/nvm" ]]; then
  . "$NVM_BREW_PREFIX/etc/bash_completion.d/nvm"
fi

if [[ -f "$HOME/zsh-z/zsh-z.plugin.zsh" ]]; then
  source "$HOME/zsh-z/zsh-z.plugin.zsh"
elif command -v brew >/dev/null 2>&1; then
  ZSH_Z_PATH="$(brew --prefix)/share/zsh-z/zsh-z.plugin.zsh"
  [[ -f "$ZSH_Z_PATH" ]] && source "$ZSH_Z_PATH"
fi

if command -v brew >/dev/null 2>&1; then
  FZF_PREFIX="$(brew --prefix)/opt/fzf"
  [[ -f "$FZF_PREFIX/shell/completion.zsh" ]] && source "$FZF_PREFIX/shell/completion.zsh"
  [[ -f "$FZF_PREFIX/shell/key-bindings.zsh" ]] && source "$FZF_PREFIX/shell/key-bindings.zsh"
fi

[[ -f /usr/share/fzf/completion.zsh ]] && source /usr/share/fzf/completion.zsh
[[ -f /usr/share/fzf/key-bindings.zsh ]] && source /usr/share/fzf/key-bindings.zsh
if command -v zoxide >/dev/null 2>&1; then
  eval "$(zoxide init zsh)"
fi

export JAVA_HOME=/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home
export ANDROID_HOME=$HOME/Library/Android/sdk
export PATH=$PATH:$ANDROID_HOME/emulator
export PATH=$PATH:$ANDROID_HOME/platform-tools


# bun
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
[ -s "$BUN_INSTALL/_bun" ] && source "$BUN_INSTALL/_bun"

alias studio='open -a "Android Studio"'
alias lg='lazygit'
export PATH="$HOME/.local/bin:$PATH"

export EDITOR="nvim"
bindkey -v

# ff — fuzzy find recent files and open them
# Usage: ff [query]  (query is optional, pre-fills fzf)
ff() {
  local IGNORE_PAT='/(node_modules|\.git|\.yarn|vendor|__pycache__|\.next|dist|build|\.cache|Cellar|Library|\.Trash|CoreSimulator|Containers/Data)/'
  local CODE_EXT='(js|ts|jsx|tsx|mjs|cjs|py|rb|go|rs|lua|sh|zsh|bash|c|cpp|h|hpp|java|kt|swift|css|scss|json|yaml|yml|toml|ini|conf|md|mdx|sql|graphql|proto)'
  local WEB_EXT='(html|htm)'
  local file action fifo
  fifo=$(mktemp -u /tmp/ff.XXXXXX)
  mkfifo "$fifo"

  {
    mdfind -onlyin ~ 'kMDItemLastUsedDate >= $time.now(-2592000)' 2>/dev/null
    fd --type f --hidden --absolute-path . 2>/dev/null
  } | grep -vE "$IGNORE_PAT" | awk '!seen[$0]++' > "$fifo" &
  local src_pid=$!
  disown

  file=$(fzf \
    --query="$*" \
    --prompt="recent> " \
    --preview='bat --color=always --style=plain --line-range=:100 {} 2>/dev/null || file {}' \
    --preview-window='right:50%:wrap' \
    --bind='esc:abort' \
    --header='enter: select  |  esc: quit' \
    < "$fifo")
  local fzf_exit=$?

  kill "$src_pid" 2>/dev/null
  rm -f "$fifo"

  (( fzf_exit != 0 )) && return

  local -a opts
  if [[ "$file" =~ \.(${WEB_EXT})$ ]]; then
    opts=("System default (browser)" "Neovim" "Copy path")
  elif [[ "$file" =~ \.(${CODE_EXT})$ ]]; then
    opts=("Neovim" "System default" "Copy path")
  else
    opts=("System default" "Copy path")
  fi

  action=$(printf '%s\n' "${opts[@]}" | fzf --prompt="open as> " --height=6 --no-preview --bind='esc:abort') || return

  case "$action" in
    "Neovim")          nvim "$file" ;;
    "System default"*) open "$file" ;;
    "Copy path")       echo -n "$file" | pbcopy && echo "Copied: $file" ;;
  esac
}


