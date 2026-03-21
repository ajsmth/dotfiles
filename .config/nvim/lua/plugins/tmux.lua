return {
  'christoomey/vim-tmux-navigator',
  init = function()
    vim.g.tmux_navigator_no_mappings = 1
  end,
  cmd = {
    'TmuxNavigateLeft',
    'TmuxNavigateDown',
    'TmuxNavigateUp',
    'TmuxNavigateRight',
    'TmuxNavigatePrevious',
    'TmuxNavigatorProcessList',
  },
  keys = {
    { '<c-h>', '<cmd>TmuxNavigateLeft<cr>' },
    { '<c-j>', '<cmd>TmuxNavigateDown<cr>' },
    { '<c-k>', '<cmd>TmuxNavigateUp<cr>' },
    { '<c-l>', '<cmd>TmuxNavigateRight<cr>' },
  },
}
