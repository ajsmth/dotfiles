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
      '--glob',
      '!**/.git/*',
      '--glob',
      '!**/.worktrees/*',
      '--glob',
      '!node_modules/**',
      '--glob',
      '!dist/**',
    }

    telescope.setup {
      defaults = {
        path_display = {
          shorten = 4,
        },
        vimgrep_arguments = grep_args,
      },

      pickers = {
        find_files = {
          hidden = true,
          find_command = {
            'rg',
            '--files',
            '--hidden',
            '--glob',
            '!**/.git/*',
            '--glob',
            '!**/.worktrees/*',
            '--glob',
            '!node_modules/**',
          },
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
  end,
}
