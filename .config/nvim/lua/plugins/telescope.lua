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
    local actions = require 'telescope.actions'
    local themes = require 'telescope.themes'
    local pickers = require 'telescope.pickers'
    local finders = require 'telescope.finders'
    local conf = require('telescope.config').values

    local function get_visual_selection()
      local mode = vim.fn.mode()
      if mode ~= 'v' and mode ~= 'V' and mode ~= '\22' then
        return nil
      end

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
        return nil
      end

      lines[1] = string.sub(lines[1], start_col)
      lines[#lines] = string.sub(lines[#lines], 1, end_col)

      return table.concat(lines, ' ')
    end

    local function grep_with_selection()
      local selection = get_visual_selection()
      local default_text = selection and vim.trim(selection) or vim.fn.expand '<cword>'

      builtin.live_grep {
        initial_mode = 'insert',
        default_text = default_text,
      }
    end

    telescope.setup {
      defaults = {
        path_display = {
          shorten = 4,
        },
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

    local session_recent_files = {}

    local function normalize_path(path)
      if not path or path == '' then
        return nil
      end

      return vim.fs.normalize(vim.fn.fnamemodify(path, ':p'))
    end

    local function to_project_path(path, cwd)
      local normalized = normalize_path(path)
      local normalized_cwd = normalize_path(cwd or vim.loop.cwd())
      if not normalized or not normalized_cwd then
        return nil
      end

      if normalized == normalized_cwd then
        return '.'
      end

      local prefix = normalized_cwd .. '/'
      if normalized:find(prefix, 1, true) == 1 then
        return normalized:sub(#prefix + 1)
      end

      return nil
    end

    local function include_in_smart_files(path)
      return path and not path:match '^node_modules/' and not path:match '/node_modules/' and not path:match '^dist/' and not path:match '/dist/'
    end

    local function list_oldfiles()
      local seen = {}
      local recent = {}

      for _, file in ipairs(vim.v.oldfiles) do
        if file and file ~= '' then
          local normalized = normalize_path(file)
          if normalized and vim.fn.filereadable(normalized) == 1 and not seen[normalized] then
            seen[normalized] = true
            table.insert(recent, normalized)
          end
        end
      end

      return recent
    end

    local function push_session_recent(path)
      local normalized = normalize_path(path)
      if not normalized or vim.fn.filereadable(normalized) ~= 1 then
        return
      end

      local updated = { normalized }
      for _, file in ipairs(session_recent_files) do
        if file ~= normalized and vim.fn.filereadable(file) == 1 then
          table.insert(updated, file)
        end
      end

      session_recent_files = updated
    end

    local oldfiles_group = vim.api.nvim_create_augroup('telescope-session-recents', { clear = true })
    vim.api.nvim_create_autocmd({ 'BufReadPost', 'BufNewFile' }, {
      group = oldfiles_group,
      callback = function(args)
        if vim.bo[args.buf].buftype ~= '' then
          return
        end

        push_session_recent(vim.api.nvim_buf_get_name(args.buf))
      end,
    })

    ---------------------------------------------------------------------
    -- SMART FILE PICKER (recent files + project files)
    ---------------------------------------------------------------------

    local function smart_files(opts)
      opts = opts or {}

      local cwd = vim.loop.cwd()

      -- get project files
      local handle = io.popen "rg --files --hidden --no-ignore --glob '!**/.git/*' --glob '!node_modules/**' --glob '!dist/**'"

      local project_files = {}
      if handle then
        for file in handle:lines() do
          local project_path = to_project_path(file, cwd)
          if include_in_smart_files(project_path) then
            table.insert(project_files, project_path)
          end
        end
        handle:close()
      end

      -- get recent files from current project
      local recent = {}
      for _, file in ipairs(session_recent_files) do
        local project_path = to_project_path(file, cwd)
        if include_in_smart_files(project_path) then
          table.insert(recent, project_path)
        end
      end

      -- merge lists (recent first)
      local seen = {}
      local results = {}

      for _, f in ipairs(recent) do
        if not seen[f] then
          seen[f] = true
          table.insert(results, f)
        end
      end

      for _, f in ipairs(project_files) do
        if not seen[f] then
          seen[f] = true
          table.insert(results, f)
        end
      end

      pickers
        .new(
          opts,
          themes.get_dropdown(vim.tbl_extend('force', {
            prompt_title = 'Files',

            finder = finders.new_table {
              results = results,
            },

            sorter = conf.file_sorter(opts),

            previewer = conf.file_previewer(opts),

            path_display = {
              shorten = 4,
            },

            mappings = {
              n = {
                ['j'] = actions.move_selection_next,
                ['k'] = actions.move_selection_previous,
              },
            },
          }, opts))
        )
        :find()
    end

    ---------------------------------------------------------------------
    -- KEYMAPS
    ---------------------------------------------------------------------

    -- Navigate recent files first
    vim.keymap.set('n', '<C-p>', function()
      smart_files {
        initial_mode = 'insert',
      }
    end, { desc = 'Files (recent first)' })

    -- Search immediately
    vim.keymap.set('n', '<C-m>', function()
      smart_files {
        initial_mode = 'insert',
      }
    end, { desc = 'Files (search)' })

    vim.keymap.set('n', '<C-g>', grep_with_selection, { desc = 'Search by Grep' })
    vim.keymap.set('x', '<C-g>', function()
      vim.schedule(grep_with_selection)
      return '<Esc>'
    end, { desc = 'Search by Grep', expr = true })

    ---------------------------------------------------------------------
    -- STANDARD TELESCOPE MAPS
    ---------------------------------------------------------------------

    vim.keymap.set('n', '<leader>sh', builtin.help_tags, { desc = '[S]earch [H]elp' })
    vim.keymap.set('n', '<leader>sk', builtin.keymaps, { desc = '[S]earch [K]eymaps' })
    vim.keymap.set('n', '<leader>sf', builtin.find_files, { desc = '[S]earch [F]iles' })
    vim.keymap.set('n', '<leader>ss', builtin.builtin, { desc = '[S]earch [S]elect Telescope' })
    vim.keymap.set('n', '<leader>sw', builtin.grep_string, { desc = '[S]earch current [W]ord' })
    vim.keymap.set('n', '<leader>sg', builtin.live_grep, { desc = '[S]earch by [G]rep' })
    vim.keymap.set('n', '<leader>sd', builtin.diagnostics, { desc = '[S]earch [D]iagnostics' })
    vim.keymap.set('n', '<leader>sr', builtin.resume, { desc = '[S]earch [R]esume' })
    vim.keymap.set('n', '<leader>s.', builtin.oldfiles, { desc = '[S]earch Recent Files' })
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
