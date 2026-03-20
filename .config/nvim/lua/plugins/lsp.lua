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
        local telescope = require 'telescope.builtin'
        local actions = require 'telescope.actions'
        local function lsp_picker(fn)
          return function()
            fn {
              previewer = true,
              layout_strategy = 'horizontal',
              layout_config = {
                preview_width = 0.6,
              },
              initial_mode = 'insert',
              mappings = {
                i = {
                  ['<C-j>'] = actions.move_selection_next,
                  ['<C-k>'] = actions.move_selection_previous,
                },
                n = {
                  ['j'] = actions.move_selection_next,
                  ['k'] = actions.move_selection_previous,
                },
              },
            }
          end
        end

        -- 🔎 Navigation (Telescope powered)
        map('gd', lsp_picker(telescope.lsp_definitions), 'Goto Definition')
        map('gr', lsp_picker(telescope.lsp_references), 'Goto References')
        map('gI', lsp_picker(telescope.lsp_implementations), 'Goto Implementation')
        map('gD', lsp_picker(telescope.lsp_type_definitions), 'Goto Type Definition')

        -- 📚 Symbols
        map('<leader>ds', lsp_picker(telescope.lsp_document_symbols), 'Document Symbols')
        map('<leader>ws', lsp_picker(telescope.lsp_workspace_symbols), 'Workspace Symbols')

        map('<leader>rn', vim.lsp.buf.rename, 'Rename Symbol')
        map('<leader>ca', vim.lsp.buf.code_action, 'Code Action', { 'n', 'x' })

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
