return {
  'alexpasmantier/tv.nvim',
  event = 'VimEnter',
  config = function()
    local tv = require 'tv'
    local h = tv.handlers
    local tv_group = vim.api.nvim_create_augroup('dotfiles-tv', { clear = true })

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

      return vim.trim(table.concat(lines, ' '))
    end

    local function run_tv(channel, query)
      local args = { channel }
      if query and query ~= '' then
        table.insert(args, query)
      end

      vim.cmd {
        cmd = 'Tv',
        args = args,
      }
    end

    local function change_cwd(entries)
      if #entries == 0 then
        return
      end

      vim.cmd.cd(vim.fn.fnameescape(entries[1]))
    end

    tv.setup {
      channels = {
        files = {
          handlers = {
            ['<CR>'] = h.open_as_files,
            ['<C-q>'] = h.send_to_quickfix,
            ['<C-s>'] = h.open_in_split,
            ['<C-v>'] = h.open_in_vsplit,
            ['<C-y>'] = h.copy_to_clipboard,
          },
        },
        text = {
          handlers = {
            ['<CR>'] = h.open_at_line,
            ['<C-q>'] = h.send_to_quickfix,
            ['<C-s>'] = h.open_in_split,
            ['<C-v>'] = h.open_in_vsplit,
            ['<C-y>'] = h.copy_to_clipboard,
          },
        },
        zoxide = {
          handlers = {
            ['<CR>'] = change_cwd,
            ['<C-y>'] = h.copy_to_clipboard,
          },
        },
        ['recent-files'] = {
          handlers = {
            ['<CR>'] = h.open_as_files,
            ['<C-q>'] = h.send_to_quickfix,
            ['<C-s>'] = h.open_in_split,
            ['<C-v>'] = h.open_in_vsplit,
            ['<C-y>'] = h.copy_to_clipboard,
          },
        },
      },
    }

    vim.api.nvim_create_autocmd('FileType', {
      group = tv_group,
      pattern = 'tv',
      callback = function(args)
        vim.keymap.set('t', '<Esc><Esc>', function()
          pcall(vim.api.nvim_win_close, 0, true)
        end, { buffer = args.buf, silent = true, desc = 'Close TV window' })

        vim.keymap.set('n', 'q', function()
          pcall(vim.api.nvim_win_close, 0, true)
        end, { buffer = args.buf, silent = true, desc = 'Close TV window' })
      end,
    })

    vim.keymap.set('n', '<C-p>', function()
      run_tv 'files'
    end, { desc = 'Find files' })

    vim.keymap.set('n', '<C-g>', function()
      run_tv 'text'
    end, { desc = 'Search by grep' })

    vim.keymap.set('x', '<C-g>', function()
      vim.schedule(function()
        run_tv('text', get_visual_selection())
      end)
      return '<Esc>'
    end, { desc = 'Search by Grep', expr = true })

    vim.keymap.set('n', '<leader>sf', function()
      run_tv 'files'
    end, { desc = '[S]earch [F]iles' })

    vim.keymap.set('n', '<leader>sg', function()
      run_tv 'text'
    end, { desc = '[S]earch by [G]rep' })

    vim.keymap.set('n', '<leader>s.', function()
      run_tv 'recent-files'
    end, { desc = '[S]earch Recent Files' })
  end,
}
