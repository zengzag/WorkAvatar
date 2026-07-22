import type { ToolDefinition } from './types'
import NotesService from '../../notes/notes.service'

/**
 * 笔记工具（合并为单工具 note）：
 * - list：列出 vault 中的笔记 / 文件夹树（可选 folder 指定子目录）
 * - read：读取指定笔记内容
 * - create：创建新笔记（含内容）
 * - update：覆盖更新笔记内容（不存在则创建）
 * - delete：删除笔记或文件夹（递归）
 * - search：全文搜索 vault 内笔记
 *
 * 所有 path 参数为相对 vault 根的 POSIX 路径，如 "folder/note.md" 或 "folder"。
 * 路径越界会被服务层拒绝。
 */

function flattenTree(nodes: any[], depth = 0, acc: string[] = []): string[] {
  for (const n of nodes) {
    const indent = '  '.repeat(depth)
    const tag = n.type === 'folder' ? '📁' : '📄'
    acc.push(`${indent}${tag} ${n.name}${n.type === 'folder' ? '/' : ''}`)
    if (n.children && n.children.length > 0) {
      flattenTree(n.children, depth + 1, acc)
    }
  }
  return acc
}

export const notesTool: ToolDefinition = {
  id: 'note',
  name: 'note',
  title: '笔记管理',
  description: `管理用户的 Markdown 笔记（基于本地 vault，真实 .md 文件）。支持 list / read / create / update / delete / search 六种操作。
- list：列出笔记树。可选 folder 限定子目录。
- read：读取笔记内容。需要 path。
- create：创建新笔记。需要 path（含文件名，以 .md 结尾）；可选 content。
- update：覆盖更新笔记内容（不存在则创建）。需要 path、content。
- delete：删除笔记或文件夹（文件夹递归删除）。需要 path。
- search：全文搜索。需要 query；可选 limit。

path 为相对 vault 根的 POSIX 路径，如 "ideas/2026.md"。文件夹路径如 "ideas"。路径越界会被拒绝。`,
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['list', 'read', 'create', 'update', 'delete', 'search'],
        description: '操作类型',
      },
      path: {
        type: 'string',
        description: '笔记或文件夹的相对路径（POSIX 风格），list 操作时可限定子目录',
      },
      content: {
        type: 'string',
        description: 'create / update 时的 Markdown 内容',
      },
      query: {
        type: 'string',
        description: 'search 操作的搜索关键词',
      },
      limit: {
        type: 'number',
        minimum: 1,
        maximum: 200,
        description: 'search 操作的最大结果数，默认 50',
      },
    },
    required: ['operation'],
  },
  handler: async (args: any) => {
    try {
      const service = NotesService.getInstance()
      const op = String(args.operation || '')

      switch (op) {
        case 'list': {
          const tree = service.listTree()
          const lines = flattenTree(tree)
          if (lines.length === 0) {
            return { success: true, output: '笔记仓库为空。', notes: [] }
          }
          return {
            success: true,
            output: `笔记仓库共 ${lines.length} 项：\n${lines.join('\n')}`,
            notes: tree,
          }
        }
        case 'read': {
          if (!args.path) return { success: false, error: 'read 操作需要 path' }
          const note = service.readNote(String(args.path))
          return {
            success: true,
            output: `笔记 ${note.relPath}（${note.size} 字节）：\n\n${note.content}`,
            path: note.relPath,
            content: note.content,
          }
        }
        case 'create': {
          if (!args.path) return { success: false, error: 'create 操作需要 path' }
          const p = String(args.path)
          // 若已存在则报错，避免误覆盖
          try {
            service.readNote(p)
            return { success: false, error: `笔记已存在：${p}，请用 update 操作或换名` }
          } catch { /* 不存在，继续 */ }
          const content = typeof args.content === 'string' ? args.content : ''
          const note = service.writeNote(p, content)
          return {
            success: true,
            output: `已创建笔记：${note.relPath}`,
            path: note.relPath,
            size: note.size,
          }
        }
        case 'update': {
          if (!args.path) return { success: false, error: 'update 操作需要 path' }
          if (typeof args.content !== 'string') return { success: false, error: 'update 操作需要 content' }
          const note = service.writeNote(String(args.path), args.content)
          return {
            success: true,
            output: `已更新笔记：${note.relPath}（${note.size} 字节）`,
            path: note.relPath,
            size: note.size,
          }
        }
        case 'delete': {
          if (!args.path) return { success: false, error: 'delete 操作需要 path' }
          service.deleteItem(String(args.path))
          return { success: true, output: `已删除：${args.path}` }
        }
        case 'search': {
          if (!args.query) return { success: false, error: 'search 操作需要 query' }
          const limit = args.limit ? Math.max(1, Math.min(200, Number(args.limit))) : 50
          const hits = service.search(String(args.query), limit)
          if (hits.length === 0) {
            return { success: true, output: `未找到包含 "${args.query}" 的笔记。`, results: [] }
          }
          const lines = hits.map((h) => {
            const snip = h.snippets.map((s) => `    L${s.line + 1}: ${s.text}`).join('\n')
            return `• ${h.relPath}\n${snip || '    (文件名命中)'}`
          })
          return {
            success: true,
            output: `找到 ${hits.length} 个笔记包含 "${args.query}"：\n${lines.join('\n')}`,
            results: hits,
          }
        }
        default:
          return { success: false, error: `不支持的操作: ${op}` }
      }
    } catch (err: any) {
      return { success: false, error: `笔记操作失败: ${err.message || err}` }
    }
  },
  source: 'builtin',
  permission: 'safe',
}

export const notesTools: ToolDefinition[] = [notesTool]
