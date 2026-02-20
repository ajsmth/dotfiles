
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
export JAVA_HOME=/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home
export ANDROID_HOME=$HOME/Library/Android/sdk
export PATH=$PATH:$ANDROID_HOME/emulator
export PATH=$PATH:$ANDROID_HOME/platform-tools


# bun completions
[ -s "/Users/andrewsmith/.bun/_bun" ] && source "/Users/andrewsmith/.bun/_bun"

# bun
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

alias studio='open -a "Android Studio"'
alias lg='lazygit'
export PATH="$HOME/.local/bin:$PATH"

export EDITOR="nvim"
bindkey -v 
