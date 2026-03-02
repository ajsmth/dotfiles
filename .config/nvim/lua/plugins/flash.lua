return {
  'folke/flash.nvim',
  event = 'VeryLazy',
  opts = {
    jump = {
      pos = 'start',
    },
    modes = {
      search = {
        enabled = true,
      },
      char = {
        enabled = false,
        jump_labels = false,
      },
    },
  },
  -- stylua: ignore
  keys = {
  },
}
