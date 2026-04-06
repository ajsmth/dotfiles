-- Set <space> as the leader key
-- See `:help mapleader`
--  NOTE: Must happen before plugins are loaded (otherwise wrong leader will be used)
vim.g.mapleader = ' '
vim.g.maplocalleader = ' '
-- Set to true if you have a Nerd Font installed and selected in the terminal
vim.g.have_nerd_font = false

-- [[ Setting options ]]
-- See `:help vim.opt`
-- NOTE: You can change these options as you wish!
--  For more options, you can see `:help option-list`

-- Make line numbers default
vim.opt.number = true
-- You can also add relative line numbers, to help with jumping.
--  Experiment for yourself to see if you like it!
vim.opt.relativenumber = true

-- Enable mouse mode, can be useful for resizing splits for example!
vim.opt.mouse = 'a'

-- Don't show the mode, since it's already in the status line
vim.opt.showmode = false

-- Sync clipboard between OS and Neovim.
--  Schedule the setting after `UiEnter` because it can increase startup-time.
--  Remove this option if you want your OS clipboard to remain independent.
--  See `:help 'clipboard'`
if vim.env.SSH_CONNECTION or vim.env.SSH_TTY or vim.env.TMUX then
  vim.g.clipboard = 'osc52'
end

vim.schedule(function()
  vim.opt.clipboard = 'unnamedplus'
end)

-- Enable break indent
vim.opt.breakindent = true

-- Save undo history
vim.opt.undofile = true

-- Case-insensitive searching UNLESS \C or one or more capital letters in the search term
vim.opt.ignorecase = true
vim.opt.smartcase = true

-- Keep signcolumn on by default
vim.opt.signcolumn = 'yes'

-- Decrease update time
vim.opt.updatetime = 250

-- Decrease mapped sequence wait time
vim.opt.timeoutlen = 300

-- Configure how new splits should be opened
vim.opt.splitright = true
vim.opt.splitbelow = true

-- Sets how neovim will display certain whitespace characters in the editor.
--  See `:help 'list'`
--  and `:help 'listchars'`
vim.opt.list = true
vim.opt.listchars = { tab = '» ', trail = '·', nbsp = '␣' }

-- Preview substitutions live, as you type!
vim.opt.inccommand = 'split'

-- Show which line your cursor is on
vim.opt.cursorline = true

-- Minimal number of screen lines to keep above and below the cursor.
vim.opt.scrolloff = 10

-- if performing an operation that would fail due to unsaved changes in the buffer (like `:q`),
-- instead raise a dialog asking if you wish to save the current file(s)
-- See `:help 'confirm'`
vim.opt.confirm = true

vim.cmd 'set expandtab'
vim.cmd 'set tabstop=2'
vim.cmd 'set softtabstop=2'
vim.cmd 'set shiftwidth=2'
vim.g.mapleader = ' '

vim.opt.swapfile = false

vim.wo.number = true

local function create_or_replace_user_command(name, command, opts)
  pcall(vim.api.nvim_del_user_command, name)
  vim.api.nvim_create_user_command(name, command, opts or {})
end

-- [[ Basic Keymaps ]]
--  See `:help vim.keymap.set()`

-- Clear highlights on search when pressing <Esc> in normal mode
--  See `:help hlsearch`
vim.keymap.set('n', '<Esc>', '<cmd>nohlsearch<CR>')
create_or_replace_user_command('W', 'w', {})

-- Diagnostic keymaps
--

-- Diagnostics Keymaps
-- =========================

-- Show diagnostic under cursor (VSCode-style hover)
vim.keymap.set('n', '<leader>e', function()
  vim.diagnostic.open_float(nil, {
    border = 'rounded',
    source = 'if_many',
    focusable = false,
  })
end, { desc = 'Show diagnostic under cursor' })

-- Jump to next diagnostic (and show float)
vim.keymap.set('n', ']d', function()
  vim.diagnostic.jump {
    count = 1,
    float = true,
  }
end, { desc = 'Next diagnostic' })

-- Jump to previous diagnostic (and show float)
vim.keymap.set('n', '[d', function()
  vim.diagnostic.jump {
    count = -1,
    float = true,
  }
end, { desc = 'Previous diagnostic' })

-- Copy ALL diagnostics on current line to system clipboard
vim.keymap.set('n', '<leader>y', function()
  local line = vim.api.nvim_win_get_cursor(0)[1] - 1
  local diagnostics = vim.diagnostic.get(0, { lnum = line })

  if #diagnostics == 0 then
    print 'No diagnostics on this line'
    return
  end

  local filename = vim.api.nvim_buf_get_name(0)
  local messages = {}

  for _, d in ipairs(diagnostics) do
    table.insert(messages, string.format('%s:%d:%d: %s', filename, d.lnum + 1, d.col + 1, d.message))
  end

  local combined = table.concat(messages, '\n')
  vim.fn.setreg('+', combined)

  print('Copied ' .. #diagnostics .. ' diagnostic(s) to clipboard')
end, { desc = 'Copy diagnostics on current line' })

-- Restore <leader>q to open full diagnostic quickfix list
vim.keymap.set('n', '<leader>q', function()
  vim.diagnostic.setqflist()
  vim.cmd 'copen'
end, { desc = 'Open diagnostic quickfix list' })
--
vim.api.nvim_create_autocmd('FileType', {
  pattern = 'qf',
  callback = function(args)
    vim.keymap.set('n', '<CR>', '<CR>', { buffer = args.buf, remap = false, silent = true })
    vim.keymap.set('n', '<C-m>', '<CR>', { buffer = args.buf, remap = false, silent = true })
  end,
})

-- Exit terminal mode in the builtin terminal with a shortcut that is a bit easier
-- for people to discover. Otherwise, you normally need to press <C-\><C-n>, which
-- is not what someone will guess without a bit more experience.
--
-- NOTE: This won't work in all terminal emulators/tmux/etc. Try your own mapping
-- or just use <C-\><C-n> to exit terminal mode
vim.keymap.set('t', '<Esc><Esc>', '<C-\\><C-n>', { desc = 'Exit terminal mode' })

local function is_terminal_buffer(buf)
  return buf and vim.api.nvim_buf_is_valid(buf) and vim.bo[buf].buftype == 'terminal'
end

local function toggle_terminal_buffer()
  local mode = vim.api.nvim_get_mode().mode
  if mode:sub(1, 1) == 't' then
    vim.cmd 'stopinsert'
  end

  local current_buf = vim.api.nvim_get_current_buf()
  local alternate_buf = vim.fn.bufnr '#'

  if is_terminal_buffer(current_buf) then
    if alternate_buf > 0 and alternate_buf ~= current_buf and vim.api.nvim_buf_is_valid(alternate_buf) then
      vim.cmd('buffer ' .. alternate_buf)
      return
    end

    vim.notify('No alternate buffer to jump back to', vim.log.levels.INFO)
    return
  end

  if alternate_buf > 0 and is_terminal_buffer(alternate_buf) then
    vim.cmd('buffer ' .. alternate_buf)
    vim.cmd 'startinsert'
    return
  end

  vim.cmd 'terminal'
  vim.bo[vim.api.nvim_get_current_buf()].buflisted = true
end

local function reload_config()
  local init = vim.fn.stdpath 'config' .. '/init.lua'
  local lazy = require 'lazy'
  local original_setup = lazy.setup

  lazy.setup = function() end

  local ok, err = xpcall(function()
    dofile(init)
    require('lazy.manage.reloader').check()
  end, debug.traceback)

  lazy.setup = original_setup

  if ok then
    vim.notify('Config reloaded', vim.log.levels.INFO, { title = 'nvim' })
    return
  end

  vim.notify(err, vim.log.levels.ERROR, { title = 'nvim' })
end

create_or_replace_user_command('TerminalToggle', toggle_terminal_buffer, {})
create_or_replace_user_command('ReloadConfig', reload_config, {
  desc = 'Reload init.lua and refresh lazy plugin specs',
})

vim.api.nvim_create_autocmd('TermOpen', {
  group = vim.api.nvim_create_augroup('dotfiles-terminal-keymaps', { clear = true }),
  callback = function(args)
    vim.opt_local.number = false
    vim.opt_local.relativenumber = false
    vim.opt_local.cursorline = false
    vim.opt_local.list = false
    vim.opt_local.signcolumn = 'no'

    vim.keymap.set('n', '<leader>tr', function()
      vim.opt_local.relativenumber = not vim.opt_local.relativenumber:get()
    end, {
      buffer = args.buf,
      desc = 'Toggle terminal relative line numbers',
    })
  end,
})

vim.keymap.set({ 'n', 't' }, '<C-\\>', toggle_terminal_buffer, { desc = 'Toggle terminal buffer' })
vim.keymap.set({ 'n', 't' }, '<leader>tp', toggle_terminal_buffer, { desc = 'Toggle terminal buffer' })

-- Keep cursor centered when jumping half a page up/down
vim.keymap.set('n', '<C-u>', '<C-u>zz')
vim.keymap.set('n', '<C-d>', '<C-d>zz')

-- [[ Basic Autocommands ]]
--  See `:help lua-guide-autocommands`

-- Highlight when yanking (copying) text
--  Try it with `yap` in normal mode
--  See `:help vim.highlight.on_yank()`
vim.api.nvim_create_autocmd('TextYankPost', {
  desc = 'Highlight when yanking (copying) text',
  group = vim.api.nvim_create_augroup('kickstart-highlight-yank', { clear = true }),
  callback = function()
    vim.highlight.on_yank()
  end,
})

-- [[ Install `lazy.nvim` plugin manager ]]
--    See `:help lazy.nvim.txt` or https://github.com/folke/lazy.nvim for more info
local lazypath = vim.fn.stdpath 'data' .. '/lazy/lazy.nvim'
if not (vim.uv or vim.loop).fs_stat(lazypath) then
  local lazyrepo = 'https://github.com/folke/lazy.nvim.git'
  local out = vim.fn.system { 'git', 'clone', '--filter=blob:none', '--branch=stable', lazyrepo, lazypath }
  if vim.v.shell_error ~= 0 then
    error('Error cloning lazy.nvim:\n' .. out)
  end
end ---@diagnostic disable-next-line: undefined-field
vim.opt.rtp:prepend(lazypath)

-- [[ Configure and install plugins ]]
--
--  To check the current status of your plugins, run
--    :Lazy
--
--  You can press `?` in this menu for help. Use `:q` to close the window
--
--  To update plugins you can run
--    :Lazy update
--
-- NOTE: Here is where you install your plugins.
require('lazy').setup({
  -- NOTE: Plugins can be added with a link (or for a github repo: 'owner/repo' link).
  'tpope/vim-sleuth', -- Detect tabstop and shiftwidth automatically

  -- NOTE: Plugins can also be added by using a table,
  -- with the first argument being the link and the following
  -- keys can be used to configure plugin behavior/loading/etc.

  -- NOTE: Plugins can also be configured to run Lua code when they are loaded.
  --
  -- This is often very useful to both group configuration, as well as handle
  -- lazy loading plugins that don't need to be loaded immediately at startup.
  --
  -- For example, in the following configuration, we use:
  --  event = 'VimEnter'
  --
  -- which loads which-key before all the UI elements are loaded. Events can be
  -- normal autocommands events (`:help autocmd-events`).
  --
  -- Then, because we use the `opts` key (recommended), the configuration runs
  -- after the plugin has been loaded as `require(MODULE).setup(opts)`.

  { -- Useful plugin to show you pending keybinds.
    'folke/which-key.nvim',
    event = 'VimEnter', -- Sets the loading event to 'VimEnter'
    opts = {
      -- delay between pressing a key and opening which-key (milliseconds)
      -- this setting is independent of vim.opt.timeoutlen
      delay = 0,
      icons = {
        -- set icon mappings to true if you have a Nerd Font
        mappings = vim.g.have_nerd_font,
        -- If you are using a Nerd Font: set icons.keys to an empty table which will use the
        -- default which-key.nvim defined Nerd Font icons, otherwise define a string table
        keys = vim.g.have_nerd_font and {} or {
          Up = '<Up> ',
          Down = '<Down> ',
          Left = '<Left> ',
          Right = '<Right> ',
          C = '<C-…> ',
          M = '<M-…> ',
          D = '<D-…> ',
          S = '<S-…> ',
          CR = '<CR> ',
          Esc = '<Esc> ',
          ScrollWheelDown = '<ScrollWheelDown> ',
          ScrollWheelUp = '<ScrollWheelUp> ',
          NL = '<NL> ',
          BS = '<BS> ',
          Space = '<Space> ',
          Tab = '<Tab> ',
          F1 = '<F1>',
          F2 = '<F2>',
          F3 = '<F3>',
          F4 = '<F4>',
          F5 = '<F5>',
          F6 = '<F6>',
          F7 = '<F7>',
          F8 = '<F8>',
          F9 = '<F9>',
          F10 = '<F10>',
          F11 = '<F11>',
          F12 = '<F12>',
        },
      },

      -- Document existing key chains
      spec = {
        { '<leader>c', group = '[C]ode', mode = { 'n', 'x' } },
        { '<leader>r', group = '[R]ename' },
        { '<leader>s', group = '[S]earch' },
        { '<leader>t', group = '[T]erminal' },
        { '<leader>w', group = '[W]orkspace' },
      },
    },
  },

  -- NOTE: Plugins can specify dependencies.
  --
  -- The dependencies are proper plugin specifications as well - anything
  -- you do for a plugin at the top level, you can do for a dependency.
  --
  -- Use the `dependencies` key to specify the dependencies of a particular plugin

  -- LSP Plugins

  -- Highlight todo, notes, etc in comments
  { 'folke/todo-comments.nvim', event = 'VimEnter', dependencies = { 'nvim-lua/plenary.nvim' }, opts = { signs = false } },

  { -- Collection of various small independent plugins/modules
    'echasnovski/mini.nvim',
    config = function()
      -- Better Around/Inside textobjects
      --
      -- Examples:
      --  - va)  - [V]isually select [A]round [)]paren
      --  - yinq - [Y]ank [I]nside [N]ext [Q]uote
      --  - ci'  - [C]hange [I]nside [']quote
      require('mini.ai').setup { n_lines = 1000 }

      -- Add/delete/replace surroundings (brackets, quotes, etc.)
      --
      -- - saiw) - [S]urround [A]dd [I]nner [W]ord [)]Paren
      -- - sd'   - [S]urround [D]elete [']quotes
      -- - sr)'  - [S]urround [R]eplace [)] [']
      require('mini.surround').setup()

      -- Simple and easy statusline.
      --  You could remove this setup call if you don't like it,
      --  and try some other statusline plugin
      -- local statusline = require 'mini.statusline'
      -- -- set use_icons to true if you have a Nerd Font
      -- statusline.setup { use_icons = vim.g.have_nerd_font }
      --
      -- -- You can configure sections in the statusline by overriding their
      -- -- default behavior. For example, here we set the section for
      -- -- cursor location to LINE:COLUMN
      -- ---@diagnostic disable-next-line: duplicate-set-field
      -- statusline.section_location = function()
      --   return '%2l:%-2v'
      -- end

      -- ... and there is more!
      --  Check out: https://github.com/echasnovski/mini.nvim
    end,
  },

  -- The following comments only work if you have downloaded the kickstart repo, not just copy pasted the
  -- init.lua. If you want these files, they are in the repository, so you can just download them and
  -- place them in the correct locations.

  --
  --  Here are some example plugins that I've included in the Kickstart repository.
  --  Uncomment any of the lines below to enable them (you will need to restart nvim).

  -- NOTE: The import below can automatically add your own plugins, configuration, etc from `lua/custom/plugins/*.lua`
  --    This is the easiest way to modularize your config.
  --
  --  Uncomment the following line and add your plugins to `lua/plugins/*.lua` to get going.
  { import = 'plugins' },
  --
  -- For additional information with loading, sourcing and examples see `:help lazy.nvim-🔌-plugin-spec`
  -- Or use telescope!
  -- In normal mode type `<space>sh` then write `lazy.nvim-plugin`
  -- you can continue same window with `<space>sr` which resumes last telescope search
}, {
  ui = {
    -- If you are using a Nerd Font: set icons to an empty table which will use the
    -- default lazy.nvim defined Nerd Font icons, otherwise define a unicode icons table
    icons = vim.g.have_nerd_font and {} or {
      cmd = '⌘',
      config = '🛠',
      event = '📅',
      ft = '📂',
      init = '⚙',
      keys = '🗝',
      plugin = '🔌',
      runtime = '💻',
      require = '🌙',
      source = '📄',
      start = '🚀',
      task = '📌',
      lazy = '💤 ',
    },
  },
})

-- The line beneath this is called `modeline`. See `:help modeline`
-- vim: ts=2 sts=2 sw=2 et
