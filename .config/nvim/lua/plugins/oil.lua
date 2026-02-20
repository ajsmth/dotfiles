return {
  'stevearc/oil.nvim',
  ---@module 'oil'
  ---@type oil.SetupOpts
  opts = {
    default_file_explorer = true,
    delete_to_trash = true,
    skip_confirm_for_simple_edits = true,
    win_options = {
      wrap = true,
      winblend = 1,
    },
    keymaps = {
      ['<C-c>'] = false,
      ['<esc><esc>'] = 'actions.close',
    },
    view_options = {
      show_hidden = true,
      natural_order = true,
      show_full_path = true,
      is_always_hidden = function(name, _)
        return name == '..' or name == '.git'
      end,
    },
  },
  -- Optional dependencies
  -- Lazy loading is not recommended because it is very tricky to make it work correctly in all situations.
  lazy = false,
  init = function()
    vim.keymap.set('n', '-', '<CMD>Oil<CR>', { desc = 'Open parent directory' })
  end,
}
