
eval "$(/opt/homebrew/bin/brew shellenv)"
fpath+=("$(brew --prefix)/share/zsh/site-functions")
autoload -U promptinit; promptinit
prompt pure

eval "$(rbenv init - --no-rehash zsh)"

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion

source $HOME/zsh-z/zsh-z.plugin.zsh
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
