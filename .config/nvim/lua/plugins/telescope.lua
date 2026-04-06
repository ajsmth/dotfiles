-- Fuzzy Finder (files, lsp, etc)
return {
  'nvim-telescope/telescope.nvim',
  event = 'VimEnter',
  branch = 'master',
  dependencies = {
    'nvim-lua/plenary.nvim',
    {
      'nvim-telescope/telescope-fzf-native.nvim',
      build = 'make',
      cond = function()
        return vim.fn.executable 'make' == 1
      end,
    },
    { 'nvim-telescope/telescope-ui-select.nvim' },
  },

  config = function()
    local telescope = require 'telescope'
    local builtin = require 'telescope.builtin'
    local themes = require 'telescope.themes'
    local ignore_globs = {
      '!**/.git/*',
      '!**/.worktrees/*',
      '!**/node_modules/**',
      '!**/dist/**',
      '!**/build/**',
    }
    local ignore_patterns = {
      '(^|/).git/',
      '(^|/).worktrees/',
      '(^|/)node_modules/',
      '(^|/)dist/',
      '(^|/)build/',
    }
    local grep_args = {
      'rg',
      '--color=never',
      '--no-heading',
      '--with-filename',
      '--line-number',
      '--column',
      '--smart-case',
      '--hidden',
      '--no-ignore',
    }
    local find_files_command = {
      'rg',
      '--files',
      '--hidden',
      '--no-ignore',
    }
    for _, glob in ipairs(ignore_globs) do
      table.insert(grep_args, '--glob')
      table.insert(grep_args, glob)
      table.insert(find_files_command, '--glob')
      table.insert(find_files_command, glob)
    end

    telescope.setup {
      defaults = {
        path_display = {
          shorten = 4,
        },
        file_ignore_patterns = ignore_patterns,
        vimgrep_arguments = grep_args,
      },

      pickers = {
        find_files = {
          hidden = true,
          find_command = find_files_command,
        },
        live_grep = {
          previewer = true,
          layout_strategy = 'horizontal',
          layout_config = {
            preview_width = 0.6,
          },
        },
        grep_string = {
          previewer = true,
          layout_strategy = 'horizontal',
          layout_config = {
            preview_width = 0.6,
          },
        },
      },

      extensions = {
        ['ui-select'] = {
          themes.get_dropdown(),
        },
      },
    }

    pcall(telescope.load_extension, 'fzf')
    pcall(telescope.load_extension, 'ui-select')

    local function get_visual_selection()
      local start_pos = vim.fn.getpos 'v'
      local end_pos = vim.fn.getpos '.'
      local start_line = start_pos[2]
      local start_col = start_pos[3]
      local end_line = end_pos[2]
      local end_col = end_pos[3]

      if start_line > end_line or (start_line == end_line and start_col > end_col) then
        start_line, end_line = end_line, start_line
        start_col, end_col = end_col, start_col
      end

      local lines = vim.fn.getline(start_line, end_line)
      if vim.tbl_isempty(lines) then
        return ''
      end

      lines[1] = string.sub(lines[1], start_col)
      lines[#lines] = string.sub(lines[#lines], 1, end_col)
      return vim.trim(table.concat(lines, ' '))
    end

    ---------------------------------------------------------------------
    -- STANDARD TELESCOPE MAPS
    ---------------------------------------------------------------------

    vim.keymap.set('n', '<leader>sh', builtin.help_tags, { desc = '[S]earch [H]elp' })
    vim.keymap.set('n', '<leader>sk', builtin.keymaps, { desc = '[S]earch [K]eymaps' })
    vim.keymap.set('n', '<leader>ss', builtin.builtin, { desc = '[S]earch [S]elect Telescope' })
    vim.keymap.set('n', '<leader>sw', builtin.grep_string, { desc = '[S]earch current [W]ord' })
    vim.keymap.set('n', '<leader>sd', builtin.diagnostics, { desc = '[S]earch [D]iagnostics' })
    vim.keymap.set('n', '<leader>sr', builtin.resume, { desc = '[S]earch [R]esume' })
    vim.keymap.set('n', '<leader><leader>', builtin.buffers, { desc = 'Find existing buffers' })

    vim.keymap.set('n', '<leader>/', function()
      builtin.current_buffer_fuzzy_find(themes.get_dropdown {
        previewer = false,
      })
    end, { desc = 'Search in current buffer' })

    vim.keymap.set('n', '<leader>s/', function()
      builtin.live_grep {
        grep_open_files = true,
        prompt_title = 'Live Grep in Open Files',
      }
    end, { desc = 'Search in Open Files' })

    vim.keymap.set('n', '<leader>sn', function()
      builtin.find_files { cwd = vim.fn.stdpath 'config' }
    end, { desc = 'Search Neovim files' })

    vim.keymap.set('n', '<C-p>', builtin.find_files, { desc = 'Find files' })
    vim.keymap.set('n', '<C-g>', builtin.live_grep, { desc = 'Search by grep' })
    vim.keymap.set('x', '<C-g>', function()
      local text = get_visual_selection()
      builtin.grep_string {
        search = vim.trim(text),
        use_regex = false,
      }
    end, { desc = 'Search by grep', silent = true })
    vim.keymap.set('n', '<leader>sf', builtin.find_files, { desc = '[S]earch [F]iles' })
    vim.keymap.set('n', '<leader>sg', builtin.live_grep, { desc = '[S]earch by [G]rep' })
    vim.keymap.set('n', '<leader>s.', builtin.oldfiles, { desc = '[S]earch Recent Files' })
  end,
}
