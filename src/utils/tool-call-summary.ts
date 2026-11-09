import i18n from '../i18n'

/**
 * 工具调用单行摘要：折叠态让用户直接看到"对什么做了什么"，
 * 而不是只有工具名。参数可能仍在流式生成（不完整 JSON），解析失败时回退原始文本。
 */

function parseArgs(args: unknown): Record<string, any> | null {
  if (!args) return null
  if (typeof args === 'object') return args as Record<string, any>
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args)
      return parsed && typeof parsed === 'object' ? parsed as Record<string, any> : null
    } catch {
      return null
    }
  }
  return null
}

function firstLine(value: unknown, max = 160): string {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function fileBaseName(value: unknown): string {
  if (typeof value !== 'string' || !value) return ''
  const segments = value.split(/[\\/]/).filter(Boolean)
  return segments[segments.length - 1] || value
}

/** 工具参数中能代表本次调用的目标字段（按优先级取第一个非空） */
const TARGET_FIELDS = [
  'command',
  'query',
  'pattern',
  'url',
  'path',
  'file_path',
  'filePath',
  'source',
  'destination',
  'target',
  'skill_name',
  'name',
  'title',
] as const

export function summarizeToolCall(toolName: string | undefined, args: unknown): string {
  const obj = parseArgs(args)

  if (!obj) {
    return typeof args === 'string' ? firstLine(args) : ''
  }

  // 文件类工具优先展示文件名，纯路径对用户没有信息量
  if (toolName && /^(file_|files_|read_image|ocr_image|grep|kms_get_content)$/.test(toolName)) {
    const path = obj.path ?? obj.file_path ?? obj.filePath
    if (typeof path === 'string' && path) return fileBaseName(path)
    const files = obj.files ?? obj.paths
    if (Array.isArray(files) && files.length > 0) {
      const first = files[0]
      const p = typeof first === 'string' ? first : (first?.path ?? first?.file_path)
      const base = fileBaseName(p)
      return files.length > 1
        ? i18n.t('workbench.toolSummaryMoreFiles', { name: base, count: files.length })
        : base
    }
  }

  if (toolName === 'shell_exec') {
    return firstLine(obj.command)
  }
  if (toolName === 'ask_user') {
    return firstLine(obj.message ?? obj.title)
  }
  if (toolName === 'todo_write') {
    const todos = obj.todos
    return Array.isArray(todos) ? i18n.t('workbench.toolSummaryItems', { count: todos.length }) : ''
  }
  if (toolName === 'launch_agents') {
    const tasks = obj.tasks
    return Array.isArray(tasks) ? i18n.t('workbench.toolSummarySubtasks', { count: tasks.length }) : ''
  }

  for (const field of TARGET_FIELDS) {
    const value = obj[field]
    if (typeof value === 'string' && value) {
      if (field === 'path' || field === 'file_path' || field === 'filePath') return fileBaseName(value)
      return firstLine(value)
    }
  }

  if (Array.isArray(obj.files) && obj.files.length > 0) {
    return i18n.t('workbench.toolSummaryFiles', { count: obj.files.length })
  }

  return ''
}
