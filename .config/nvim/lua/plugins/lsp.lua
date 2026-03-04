return {
  -- Main LSP Configuration
  'neovim/nvim-lspconfig',
  dependencies = {
    -- Automatically install LSPs and related tools to stdpath for Neovim
    -- Mason must be loaded before its dependents so we need to set it up here.
    -- NOTE: `opts = {}` is the same as calling `require('mason').setup({})`
    { 'williamboman/mason.nvim', opts = {} },
    'williamboman/mason-lspconfig.nvim',
    'WhoIsSethDaniel/mason-tool-installer.nvim',

    -- Allows extra capabilities provided by nvim-cmp
    'hrsh7th/cmp-nvim-lsp',
  },
  config = function()
    -- Diagnostics UI
    vim.diagnostic.config {
      severity_sort = true,
      float = { border = 'rounded', source = 'if_many' },
      underline = true,
      virtual_text = false,
      update_in_insert = false,
    }

    local comment_hl = vim.api.nvim_get_hl(0, { name = 'Comment' })

    vim.api.nvim_set_hl(0, 'DiagnosticUnnecessary', {
      fg = comment_hl.fg,
      italic = true,
    })
    -- Extend LSP capabilities with nvim-cmp
    local capabilities = vim.lsp.protocol.make_client_capabilities()
    capabilities = vim.tbl_deep_extend('force', capabilities, require('cmp_nvim_lsp').default_capabilities())

    -- Define all servers here
    local servers = {
      -- ✅ TypeScript (Neovim 0.11+ name)
      ts_ls = {},

      -- ✅ Lua
      lua_ls = {
        settings = {
          Lua = {
            completion = {
              callSnippet = 'Replace',
            },
            diagnostics = {
              globals = { 'vim' },
            },
          },
        },
      },
    }

    -- Ensure servers + tools are installed
    local ensure_installed = vim.tbl_keys(servers)
    vim.list_extend(ensure_installed, {
      'stylua',
      'clang-format',
      'cpplint',
    })

    require('mason-tool-installer').setup {
      ensure_installed = ensure_installed,
    }

    -- Setup and enable all servers safely
    for name, config in pairs(servers) do
      config.capabilities = vim.tbl_deep_extend('force', {}, capabilities, config.capabilities or {})

      vim.lsp.config(name, config)
      vim.lsp.enable(name)
    end
    vim.api.nvim_create_autocmd('LspAttach', {
      group = vim.api.nvim_create_augroup('custom-lsp-attach', { clear = true }),
      callback = function(event)
        local client = vim.lsp.get_client_by_id(event.data.client_id)
        if not client then
          return
        end

        local map = function(keys, func, desc, mode)
          mode = mode or 'n'
          vim.keymap.set(mode, keys, func, {
            buffer = event.buf,
            desc = 'LSP: ' .. desc,
          })
        end

        -- 🔎 Navigation
        map('gd', vim.lsp.buf.definition, 'Goto Definition')
        map('gD', vim.lsp.buf.declaration, 'Goto Declaration')
        map('gr', vim.lsp.buf.references, 'Goto References')
        map('gI', vim.lsp.buf.implementation, 'Goto Implementation')

        -- 🛠 Refactoring
        map('<leader>rn', vim.lsp.buf.rename, 'Rename Symbol')
        map('<leader>ca', vim.lsp.buf.code_action, 'Code Action', { 'n', 'x' })

        -- 📚 Symbols
        map('<leader>ds', vim.lsp.buf.document_symbol, 'Document Symbols')
        map('<leader>ws', vim.lsp.buf.workspace_symbol, 'Workspace Symbols')

        -- 💬 Hover
        map('K', vim.lsp.buf.hover, 'Hover Documentation')

        -- ✨ Highlight symbol under cursor
        if client.supports_method 'textDocument/documentHighlight' then
          local highlight_group = vim.api.nvim_create_augroup('custom-lsp-highlight', { clear = false })

          vim.api.nvim_create_autocmd({ 'CursorHold', 'CursorHoldI' }, {
            buffer = event.buf,
            group = highlight_group,
            callback = vim.lsp.buf.document_highlight,
          })

          vim.api.nvim_create_autocmd({ 'CursorMoved', 'CursorMovedI' }, {
            buffer = event.buf,
            group = highlight_group,
            callback = vim.lsp.buf.clear_references,
          })
        end
      end,
    })

    -- Optional but recommended (makes highlights feel instant)
    vim.o.updatetime = 250
    -- Highlight symbol under cursor (LSP documentHighlight)
  end,
}
