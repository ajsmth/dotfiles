return {
  'sindrets/diffview.nvim',
  cmd = {
    'DiffviewOpen',
    'DiffviewFileHistory',
    'DiffviewClose',
    'DiffviewFocusFiles',
    'DiffviewToggleFiles',
    'DiffviewRefresh',
  },
  dependencies = {
    'nvim-lua/plenary.nvim',
  },
  opts = {
    use_icons = false,
  },
  keys = {
    { '<leader>gd', '<cmd>DiffviewOpen<cr>', desc = 'Open Diffview' },
    { '<leader>gD', '<cmd>DiffviewFileHistory %<cr>', desc = 'File history' },
    { '<leader>gH', '<cmd>DiffviewFileHistory<cr>', desc = 'Repo history' },
    { '<leader>gq', '<cmd>DiffviewClose<cr>', desc = 'Close Diffview' },
  },
}
