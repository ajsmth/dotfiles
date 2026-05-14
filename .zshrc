
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

_tmux_smart_window_option_enabled() {
  local value
  value="$(tmux show-option -wqv automatic-rename 2>/dev/null)"
  [[ "$value" == "on" || "$value" == "1" ]]
}

_tmux_smart_window_preexec() {
  [[ -n "${TMUX:-}" ]] || return
  command -v tmux >/dev/null 2>&1 || return
  _tmux_smart_window_option_enabled || return

  local label
  label="$("$HOME/.local/bin/tmux-smart-window-name" --command "$1" "$PWD" 2>/dev/null)" || return
  [[ -n "$label" ]] || return

  tmux rename-window "$label" \; \
    set-option -w automatic-rename off \; \
    set-option -w @smart-window-name-active 1 >/dev/null 2>&1
}

_tmux_smart_window_precmd() {
  [[ -n "${TMUX:-}" ]] || return
  command -v tmux >/dev/null 2>&1 || return

  local smart_active auto_enabled label
  smart_active="$(tmux show-option -wqv @smart-window-name-active 2>/dev/null)"
  auto_enabled="$(_tmux_smart_window_option_enabled && printf 1 || true)"
  [[ "$smart_active" == "1" || "$auto_enabled" == "1" ]] || return

  label="$("$HOME/.local/bin/tmux-smart-window-name" --command "" "$PWD" 2>/dev/null)" || return
  [[ -n "$label" ]] || return

  tmux rename-window "$label" \; \
    set-option -w automatic-rename on \; \
    set-option -wu @smart-window-name-active >/dev/null 2>&1
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec _tmux_smart_window_preexec
add-zsh-hook precmd _tmux_smart_window_precmd


# opencode
export PATH=/Users/andrewsmith/.opencode/bin:$PATH

if [[ -f "$HOME/.zshrc.local" ]]; then
  source "$HOME/.zshrc.local"
fi

if command -v wt >/dev/null 2>&1; then eval "$(command wt config shell init zsh)"; fi

if command -v nvm >/dev/null 2>&1; then
  nvm use default >/dev/null 2>&1 || true
fi
