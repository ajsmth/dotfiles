return {
  'alexpasmantier/tv.nvim',
  event = 'VimEnter',
  config = function()
    local tv = require 'tv'
    local h = tv.handlers
    local tv_group = vim.api.nvim_create_augroup('dotfiles-tv', { clear = true })

    tv.setup {
      channels = {
        zoxide = {
          handlers = {
            ['<CR>'] = function(entries)
              if #entries == 0 then
                return
              end

              vim.cmd.cd(vim.fn.fnameescape(entries[1]))
            end,
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

  end,
}
