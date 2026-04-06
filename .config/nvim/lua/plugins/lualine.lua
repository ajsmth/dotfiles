return {
  'nvim-lualine/lualine.nvim',
  init = function()
    local function is_terminal_buffer()
      return vim.bo.buftype == 'terminal'
    end

    local function current_branch()
      if is_terminal_buffer() then
        return ''
      end

      local branch = vim.b.gitsigns_head
      if branch == nil or branch == '' then
        return ''
      end

      local max_length = 24
      if #branch <= max_length then
        return branch
      end

      local segments = vim.split(branch, '/', { plain = true })
      if #segments > 1 then
        local prefix_segments = {}
        for i = 1, #segments - 1 do
          table.insert(prefix_segments, segments[i])
        end

        local prefix = table.concat(prefix_segments, '/')
        local suffix = segments[#segments]
        local reserved = #prefix + 2
        local available = max_length - reserved

        if available > 4 and #suffix > available then
          suffix = suffix:sub(1, available - 4) .. '...'
        end

        local shortened = prefix .. '/' .. suffix
        if #shortened <= max_length then
          return shortened
        end
      end

      return branch:sub(1, max_length - 3) .. '...'
    end

    local function current_path()
      if is_terminal_buffer() then
        return 'terminal'
      end

      local path = vim.api.nvim_buf_get_name(0)
      if path == '' then
        return '[No Name]'
      end

      local cwd = vim.uv.cwd()
      local git_dir = vim.fs.find('.git', {
        path = path,
        upward = true,
        stop = cwd and vim.fs.dirname(cwd) or nil,
      })[1]

      local root = git_dir and vim.fs.dirname(git_dir) or cwd
      local relative = root and vim.fs.relpath(root, path) or nil
      if relative ~= nil and relative ~= '' then
        return relative
      end

      relative = cwd and vim.fs.relpath(cwd, path) or nil
      if relative ~= nil and relative ~= '' then
        return relative
      end

      return vim.fn.fnamemodify(path, ':t')
    end

    require('lualine').setup {
      options = {
        icons_enabled = false,
        theme = 'auto',
        component_separators = { left = '', right = '' },
        section_separators = { left = '', right = '' },
        disabled_filetypes = {
          statusline = {},
          winbar = {},
        },
        ignore_focus = {},
        always_divide_middle = true,
        always_show_tabline = true,
        globalstatus = false,
        refresh = {
          statusline = 100,
          tabline = 100,
          winbar = 100,
        },
      },
      sections = {
        lualine_a = { 'mode' },
        lualine_b = { current_branch, 'diff' },
        lualine_c = { current_path },
        lualine_x = {},
        lualine_y = {},
        lualine_z = {},
      },
      inactive_sections = {
        lualine_a = {},
        lualine_b = {},
        lualine_c = { current_path },
        lualine_x = { 'location' },
        lualine_y = {},
        lualine_z = {},
      },
      tabline = {},
      winbar = {},
      inactive_winbar = {},
      extensions = {},
    }
  end,
}
