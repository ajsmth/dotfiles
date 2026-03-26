return {
  'NeogitOrg/neogit',
  lazy = true,
  dependencies = {
    'nvim-lua/plenary.nvim', -- required

    -- Only one of these is needed.
    {
      'sindrets/diffview.nvim',
      opts = {
        use_icons = false,
      },
    }, -- optional

    -- Only one of these is needed.
    'nvim-telescope/telescope.nvim', -- optional
  },
  cmd = 'Neogit',
  opts = {
    kind = 'replace',
  },
  keys = {
    { '<leader>gg', '<cmd>Neogit<cr>', desc = 'Show Neogit UI' },
    { '<leader>gq', '<cmd>DiffviewClose<cr>', desc = 'Close Diffview' },
    { '<S-l>', '<cmd>tabnext<cr>', desc = 'Next tab' },
    { '<S-h>', '<cmd>tabprevious<cr>', desc = 'Previous tab' },
    { '<leader>tn', '<cmd>tabnext<cr>', desc = 'Next tab' },
    { '<leader>tp', '<cmd>tabprevious<cr>', desc = 'Previous tab' },
    { '<leader>tq', '<cmd>tabclose<cr>', desc = 'Close tab' },
  },
}
