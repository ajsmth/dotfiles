local M = {}

local ns = vim.api.nvim_create_namespace 'review-annotations'
local annotations = {}
local next_id = 0

local function normalize_path(path)
  if path == '' then
    return nil
  end

  return vim.fs.normalize(vim.fn.fnamemodify(path, ':p'))
end

local function relpath(path)
  local cwd = vim.uv.cwd()
  local relative = cwd and vim.fs.relpath(cwd, path) or nil
  return relative or path
end

local function current_path()
  return normalize_path(vim.api.nvim_buf_get_name(0))
end

local function annotation_key(path, line)
  return path .. '\0' .. line
end

local function annotation_lines(annotation)
  local lines = {}

  if annotation.bufnr and vim.api.nvim_buf_is_valid(annotation.bufnr) and annotation.marks then
    for _, mark in ipairs(annotation.marks) do
      local pos = vim.api.nvim_buf_get_extmark_by_id(annotation.bufnr, ns, mark, {})
      if pos and pos[1] then
        table.insert(lines, pos[1] + 1)
      end
    end
  end

  if #lines == 0 then
    for line = annotation.start_line, annotation.end_line do
      table.insert(lines, line)
    end
  end

  table.sort(lines)
  return lines
end

local function annotation_range(annotation)
  local lines = annotation_lines(annotation)
  return lines[1] or annotation.start_line, lines[#lines] or annotation.end_line
end

local function contains_line(annotation, line)
  local start_line, end_line = annotation_range(annotation)
  return line >= start_line and line <= end_line
end

local function overlaps_range(annotation, start_line, end_line)
  local annotation_start, annotation_end = annotation_range(annotation)
  return annotation_start <= end_line and start_line <= annotation_end
end

local function find_at(path, line)
  for key, annotation in pairs(annotations) do
    if annotation.path == path and contains_line(annotation, line) then
      return key, annotation
    end
  end
end

local function find_overlapping(path, start_line, end_line)
  local matches = {}
  for key, annotation in pairs(annotations) do
    if annotation.path == path and overlaps_range(annotation, start_line, end_line) then
      table.insert(matches, { key = key, annotation = annotation })
    end
  end
  return matches
end

local function refresh_annotation(annotation)
  if not annotation.bufnr or not vim.api.nvim_buf_is_valid(annotation.bufnr) then
    return
  end

  for _, mark in ipairs(annotation.marks or {}) do
    pcall(vim.api.nvim_buf_del_extmark, annotation.bufnr, ns, mark)
  end
  annotation.marks = {}

  local max_line = vim.api.nvim_buf_line_count(annotation.bufnr)
  local start_line = math.max(1, math.min(annotation.start_line, max_line))
  local end_line = math.max(start_line, math.min(annotation.end_line, max_line))

  for line = start_line, end_line do
    local is_first = line == start_line
    local mark = vim.api.nvim_buf_set_extmark(annotation.bufnr, ns, line - 1, 0, {
      sign_text = is_first and '>>' or '| ',
      sign_hl_group = 'DiagnosticInfo',
      virt_text = is_first and { { end_line > start_line and ' annotation range' or ' annotation', 'Comment' } } or nil,
      virt_text_pos = 'eol',
    })
    table.insert(annotation.marks, mark)
  end
end

local function refresh_buffer(bufnr)
  if not vim.api.nvim_buf_is_valid(bufnr) then
    return
  end

  local path = normalize_path(vim.api.nvim_buf_get_name(bufnr))
  if not path then
    return
  end

  for _, annotation in pairs(annotations) do
    if annotation.path == path then
      annotation.start_line, annotation.end_line = annotation_range(annotation)
    end
  end

  vim.api.nvim_buf_clear_namespace(bufnr, ns, 0, -1)

  for _, annotation in pairs(annotations) do
    if annotation.path == path then
      annotation.bufnr = bufnr
      refresh_annotation(annotation)
    end
  end
end

local function line_text(path, line)
  for _, bufnr in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_valid(bufnr) and normalize_path(vim.api.nvim_buf_get_name(bufnr)) == path then
      local lines = vim.api.nvim_buf_get_lines(bufnr, line - 1, line, false)
      return lines[1] or ''
    end
  end

  local ok, lines = pcall(vim.fn.readfile, path, '', line)
  if ok then
    return lines[line] or ''
  end

  return ''
end

local function sorted_annotations()
  local items = vim.tbl_values(annotations)
  table.sort(items, function(left, right)
    if left.path == right.path then
      local left_line = annotation_range(left)
      local right_line = annotation_range(right)
      return left_line < right_line
    end

    return left.path < right.path
  end)
  return items
end

local function normalize_range(start_line, end_line)
  if not start_line or start_line == 0 then
    start_line = vim.api.nvim_win_get_cursor(0)[1]
  end
  end_line = end_line or start_line

  if start_line > end_line then
    start_line, end_line = end_line, start_line
  end

  return start_line, end_line
end

local function remove_annotation(key, annotation)
  for _, mark in ipairs(annotation.marks or {}) do
    if annotation.bufnr and vim.api.nvim_buf_is_valid(annotation.bufnr) then
      pcall(vim.api.nvim_buf_del_extmark, annotation.bufnr, ns, mark)
    end
  end
  annotations[key] = nil
end

function M.add(start_line, end_line)
  local path = current_path()
  if not path then
    vim.notify('Cannot annotate an unnamed buffer.', vim.log.levels.WARN)
    return
  end

  local bufnr = vim.api.nvim_get_current_buf()
  start_line, end_line = normalize_range(start_line, end_line)
  local overlapping = find_overlapping(path, start_line, end_line)
  local existing = #overlapping == 1 and overlapping[1].annotation or nil

  vim.ui.input({ prompt = 'Annotation: ', default = existing and existing.text or '' }, function(input)
    if input == nil then
      return
    end

    input = vim.trim(input)
    if input == '' then
      for _, item in ipairs(overlapping) do
        remove_annotation(item.key, item.annotation)
      end
      return
    end

    for _, item in ipairs(overlapping) do
      remove_annotation(item.key, item.annotation)
    end

    next_id = next_id + 1
    local annotation = {
      id = next_id,
      path = path,
      bufnr = bufnr,
      start_line = start_line,
      end_line = end_line,
      text = input,
    }

    annotations[annotation_key(path, start_line)] = annotation
    refresh_annotation(annotation)
  end)
end

function M.clear_current()
  local path = current_path()
  if not path then
    return
  end

  local line = vim.api.nvim_win_get_cursor(0)[1]
  local key, annotation = find_at(path, line)
  if not key then
    vim.notify('No annotation on this line.', vim.log.levels.INFO)
    return
  end

  local start_line, end_line = annotation_range(annotation)
  remove_annotation(key, annotation)
end

function M.clear_all()
  annotations = {}
  for _, bufnr in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_valid(bufnr) then
      vim.api.nvim_buf_clear_namespace(bufnr, ns, 0, -1)
    end
  end
end

function M.to_markdown()
  local items = sorted_annotations()
  if #items == 0 then
    return ''
  end

  local lines = { '# Review annotations', '' }
  local current_file

  for _, annotation in ipairs(items) do
    local start_line, end_line = annotation_range(annotation)
    local file = relpath(annotation.path)

    if file ~= current_file then
      if current_file then
        table.insert(lines, '')
      end
      current_file = file
      table.insert(lines, '## ' .. file)
      table.insert(lines, '')
    end

    if start_line == end_line then
      table.insert(lines, ('- `%s:%d`'):format(file, start_line))
      table.insert(lines, ('  - Code: `%s`'):format(line_text(annotation.path, start_line)))
    else
      table.insert(lines, ('- `%s:%d-%d`'):format(file, start_line, end_line))
      table.insert(lines, '  - Code:')
      table.insert(lines, '    ```')
      for line = start_line, end_line do
        table.insert(lines, line_text(annotation.path, line))
      end
      table.insert(lines, '    ```')
    end

    for text_line in annotation.text:gmatch '[^\n]+' do
      table.insert(lines, '  - Note: ' .. text_line)
    end
  end

  table.insert(lines, '')
  return table.concat(lines, '\n')
end

function M.copy()
  local markdown = M.to_markdown()
  if markdown == '' then
    vim.notify('No review annotations to copy.', vim.log.levels.INFO)
    return
  end

  vim.fn.setreg('+', markdown)
  vim.fn.setreg('"', markdown)
end

function M.open_scratch()
  local markdown = M.to_markdown()
  if markdown == '' then
    vim.notify('No review annotations to show.', vim.log.levels.INFO)
    return
  end

  vim.cmd 'new'
  local bufnr = vim.api.nvim_get_current_buf()
  vim.bo[bufnr].buftype = 'nofile'
  vim.bo[bufnr].bufhidden = 'wipe'
  vim.bo[bufnr].swapfile = false
  vim.bo[bufnr].filetype = 'markdown'
  vim.api.nvim_buf_set_name(bufnr, 'review-annotations.md')
  vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, vim.split(markdown, '\n', { plain = true }))
end

function M.setup()
  local function create_command(name, callback, opts)
    pcall(vim.api.nvim_del_user_command, name)
    vim.api.nvim_create_user_command(name, callback, opts or {})
  end

  vim.api.nvim_create_autocmd({ 'BufEnter', 'BufWritePost' }, {
    group = vim.api.nvim_create_augroup('review-annotations', { clear = true }),
    callback = function(args)
      refresh_buffer(args.buf)
    end,
  })

  create_command('ReviewAnnotateAdd', function(opts)
    if opts.range == 0 then
      M.add()
    else
      M.add(opts.line1, opts.line2)
    end
  end, { range = true })
  create_command('ReviewAnnotateClear', M.clear_current)
  create_command('ReviewAnnotateClearAll', M.clear_all)
  create_command('ReviewAnnotateCopy', M.copy)
  create_command('ReviewAnnotateShow', M.open_scratch)

  vim.keymap.set('n', '<leader>aa', M.add, { desc = 'Add review annotation' })
  vim.keymap.set('x', '<leader>aa', ':ReviewAnnotateAdd<CR>', { desc = 'Add review annotation' })
  vim.keymap.set('n', '<leader>ad', M.clear_current, { desc = 'Delete review annotation' })
  vim.keymap.set('n', '<leader>aD', M.clear_all, { desc = 'Delete all review annotations' })
  vim.keymap.set('n', '<leader>ay', M.copy, { desc = 'Copy review annotations' })
  vim.keymap.set('n', '<leader>as', M.open_scratch, { desc = 'Show review annotations' })
end

return M
