import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { interactionContext } from '../../../electron/main/services/unified-interaction.service'
import { fileListTool } from '../../../electron/main/services/agent/tools/file-list.tool'
import { grepTool } from '../../../electron/main/services/agent/tools/grep.tool'
import { filesEditTool } from '../../../electron/main/services/agent/tools/files-edit.tool'
import { envProbeTool } from '../../../electron/main/services/agent/tools/env-probe.tool'

/**
 * 编程基础工具（file_list / grep / files_edit 常驻，env_probe 按需）行为覆盖。
 * 相对路径按工作区解析，故统一用 interactionContext 注入工作区。
 */

type ToolResult = { success: boolean; output?: any; error?: string }

function makeTemp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function withWorkspace<T>(ws: string, sessionId: string, fn: () => Promise<T> | T): Promise<T> {
  return interactionContext.run(
    { sessionId, employeeId: 'e1', workspacePath: ws, highPermission: false } as never,
    async () => fn(),
  ) as Promise<T>
}

const list = (args: any): Promise<ToolResult> => fileListTool.handler!(args) as Promise<ToolResult>
const grep = (args: any): Promise<ToolResult> => grepTool.handler!(args) as Promise<ToolResult>
const patch = (args: any): Promise<ToolResult> => filesEditTool.handler!(args) as Promise<ToolResult>

function seed(root: string, rel: string, content: string): string {
  const target = path.join(root, rel)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, 'utf-8')
  return target
}

describe('agent/tools/file-list', () => {
  let ws: string

  beforeEach(() => { ws = makeTemp('wa-fl-') })
  afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }) })

  it('列出直接子项：目录带 / 后缀，文件带体积，重目录被跳过', async () => {
    seed(ws, 'src/a.ts', 'const a = 1\n')
    seed(ws, 'node_modules/pkg/index.js', 'module.exports = 1\n')
    seed(ws, 'readme.md', '# hi\n')
    fs.mkdirSync(path.join(ws, 'docs'))

    await withWorkspace(ws, 'fl-1', async () => {
      const res = await list({ path: ws })
      expect(res.success, res.error).toBe(true)
      expect(res.output).toContain('目录 2 / 文件 1')
      expect(res.output).toContain('- src/')
      expect(res.output).toContain('- docs/')
      expect(res.output).toContain('- readme.md')
      expect(res.output).not.toContain('node_modules')
    })
  })

  it('pattern 跨目录匹配嵌套文件，并说明基准目录', async () => {
    seed(ws, 'src/deep/b.ts', 'b\n')
    seed(ws, 'src/a.ts', 'a\n')
    seed(ws, 'src/notes.md', 'n\n')

    await withWorkspace(ws, 'fl-2', async () => {
      const res = await list({ path: ws, pattern: '**/*.ts' })
      expect(res.success, res.error).toBe(true)
      expect(res.output).toContain('匹配 "**/*.ts"：共 2 项')
      expect(res.output).toContain('- src/a.ts')
      expect(res.output).toContain('- src/deep/b.ts')
      expect(res.output).not.toContain('notes.md')
      expect(res.output).toContain(`（以上路径相对基准目录 ${ws}）`)
    })
  })

  it('默认隐藏点开头的项，show_hidden=true 时显示', async () => {
    seed(ws, '.env', 'A=1\n')
    seed(ws, 'app.ts', 'x\n')

    await withWorkspace(ws, 'fl-3', async () => {
      expect((await list({ path: ws })).output).not.toContain('.env')
      expect((await list({ path: ws, show_hidden: true })).output).toContain('.env')
    })
  })

  it('pattern 不含通配符时报错并给出指引', async () => {
    await withWorkspace(ws, 'fl-4', async () => {
      const res = await list({ path: ws, pattern: 'src/a.ts' })
      expect(res.success).toBe(false)
      expect(res.error).toContain('不含通配符')
    })
  })

  it('路径不存在 / 传入文件时分别报错与回显文件信息', async () => {
    const file = seed(ws, 'a.ts', 'hello')
    await withWorkspace(ws, 'fl-5', async () => {
      expect((await list({ path: path.join(ws, 'nope') })).error).toContain('路径不存在')
      const res = await list({ path: file })
      expect(res.success).toBe(true)
      expect(res.output).toContain('（文件，')
    })
  })

  it('max_items 截断时给出提示', async () => {
    for (let i = 0; i < 5; i++) seed(ws, `f${i}.ts`, 'x\n')
    await withWorkspace(ws, 'fl-6', async () => {
      const res = await list({ path: ws, max_items: 2 })
      expect(res.success).toBe(true)
      expect(res.output).toContain('结果不完整')
    })
  })

  it('工作区尚未创建（懒创建）时按空目录返回而非报路径不存在', async () => {
    fs.rmSync(ws, { recursive: true, force: true })
    await withWorkspace(ws, 'fl-7', async () => {
      const res = await list({})
      expect(res.success, res.error).toBe(true)
      expect(res.output).toContain('共 0 项')
      expect(res.output).toContain('工作区尚未创建')

      const withPattern = await list({ pattern: '**/*.ts' })
      expect(withPattern.success, withPattern.error).toBe(true)
      expect(withPattern.output).toContain('共 0 项')
    })
  })

  it('工具元信息：常驻、只读、无必填参数', () => {
    expect(fileListTool.id).toBe('file_list')
    expect(fileListTool.onDemand).toBe(false)
    expect(fileListTool.permission).toBe('safe')
    expect(fileListTool.parameters.required).toEqual([])
  })
})

describe('agent/tools/grep', () => {
  let ws: string

  beforeEach(() => { ws = makeTemp('wa-gr-') })
  afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }) })

  it('跨文件命中并以 路径:行号: 内容 输出', async () => {
    seed(ws, 'src/a.ts', 'const one = 1\nconst target = 2\n')
    seed(ws, 'src/deep/b.ts', 'target()\n')
    seed(ws, 'readme.md', 'no match here\n')

    await withWorkspace(ws, 'gr-1', async () => {
      const res = await grep({ pattern: 'target' })
      expect(res.success, res.error).toBe(true)
      expect(res.output).toContain('命中 2 处，涉及 2 个文件')
      expect(res.output).toContain('src/a.ts:2: const target = 2')
      expect(res.output).toContain('src/deep/b.ts:1: target()')
    })
  })

  it('未命中时明确提示且不误报文件数', async () => {
    seed(ws, 'a.ts', 'nothing\n')
    await withWorkspace(ws, 'gr-2', async () => {
      const res = await grep({ pattern: 'zzz-not-exist' })
      expect(res.success).toBe(true)
      expect(res.output).toContain('命中 0 处')
      expect(res.output).toContain('（未找到匹配）')
    })
  })

  it('ignore_case 控制大小写；glob 限定候选文件', async () => {
    seed(ws, 'a.ts', 'TARGET\n')
    seed(ws, 'b.md', 'TARGET\n')

    await withWorkspace(ws, 'gr-3', async () => {
      expect((await grep({ pattern: 'target' })).output).toContain('命中 0 处')
      expect((await grep({ pattern: 'target', ignore_case: true })).output).toContain('命中 2 处')

      const limited = await grep({ pattern: 'TARGET', glob: '**/*.ts' })
      expect(limited.output).toContain('命中 1 处')
      expect(limited.output).not.toContain('b.md')
    })
  })

  it('context_lines 输出上下文行（路径-行号- 内容）', async () => {
    seed(ws, 'a.ts', 'l1\nl2\nHIT\nl4\nl5\n')
    await withWorkspace(ws, 'gr-4', async () => {
      const res = await grep({ pattern: 'HIT', context_lines: 1 })
      expect(res.output).toContain('a.ts:3: HIT')
      expect(res.output).toContain('a.ts-2- l2')
      expect(res.output).toContain('a.ts-4- l4')
      expect(res.output).not.toContain('l1')
    })
  })

  it('跳过 node_modules、二进制与超大文件', async () => {
    seed(ws, 'node_modules/pkg/a.js', 'TARGET\n')
    fs.writeFileSync(path.join(ws, 'bin.dat'), Buffer.from([0x54, 0x41, 0x52, 0x00, 0x47]))
    seed(ws, 'ok.ts', 'TARGET\n')

    await withWorkspace(ws, 'gr-5', async () => {
      const res = await grep({ pattern: 'TARGET' })
      expect(res.output).toContain('命中 1 处')
      expect(res.output).not.toContain('node_modules')
      expect(res.output).toMatch(/跳过 \d+ 个二进制文件/)
    })
  })

  it('pattern 为空或正则有误时报错（含转义提示）', async () => {
    await withWorkspace(ws, 'gr-6', async () => {
      expect((await grep({ pattern: '' })).error).toContain('pattern 不能为空')
      const bad = await grep({ pattern: 'a(' })
      expect(bad.success).toBe(false)
      expect(bad.error).toContain('正则表达式无效')
    })
  })

  it('工作区尚未创建（懒创建）时按无文件可搜索返回', async () => {
    fs.rmSync(ws, { recursive: true, force: true })
    await withWorkspace(ws, 'gr-9', async () => {
      const res = await grep({ pattern: 'anything' })
      expect(res.success, res.error).toBe(true)
      expect(res.output).toContain('命中 0 处')
      expect(res.output).toContain('工作区尚未创建')
    })
  })

  it('path 指向单个文件时只检索该文件', async () => {
    const file = seed(ws, 'only.ts', 'TARGET\n')
    seed(ws, 'other.ts', 'TARGET\n')
    await withWorkspace(ws, 'gr-7', async () => {
      const res = await grep({ pattern: 'TARGET', path: file })
      expect(res.output).toContain('命中 1 处')
      expect(res.output).toContain('only.ts:1: TARGET')
    })
  })

  it('超长单行按 2000 字节截断并标记', async () => {
    seed(ws, 'min.js', `${'a'.repeat(5000)}TARGET\n`)
    await withWorkspace(ws, 'gr-8', async () => {
      const res = await grep({ pattern: 'TARGET' })
      expect(res.output).toContain('该行超过 2000 字节已截断')
      expect(Buffer.byteLength(String(res.output), 'utf8')).toBeLessThan(5000)
    })
  })

  it('工具元信息：常驻、只读、pattern 必填', () => {
    expect(grepTool.onDemand).toBe(false)
    expect(grepTool.permission).toBe('safe')
    expect(grepTool.parameters.required).toEqual(['pattern'])
  })
})

describe('agent/tools/files-edit', () => {
  let ws: string

  beforeEach(() => { ws = makeTemp('wa-ap-') })
  afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }) })

  it('一次修改多个文件，结果只回写入摘要（diff 仅供确认弹窗）', async () => {
    const a = seed(ws, 'src/a.ts', 'const a = 1\n')
    const b = seed(ws, 'src/b.ts', 'const b = 2\n')

    await withWorkspace(ws, 'ap-1', async () => {
      const res = await patch({
        changes: [
          { path: a, edits: [{ old_string: 'const a = 1', new_string: 'const a = 10' }] },
          { path: b, edits: [{ old_string: 'const b = 2', new_string: 'const b = 20' }] },
        ],
      })
      expect(res.success, res.error).toBe(true)
      expect(res.output).toContain('共 2 个文件，已写入 2 个')
      // diff 不再进入模型上下文（避免长期占用 token）
      expect(res.output).not.toContain('--- ')
      expect(res.output).not.toContain('```diff')
    })
    expect(fs.readFileSync(a, 'utf-8')).toBe('const a = 10\n')
    expect(fs.readFileSync(b, 'utf-8')).toBe('const b = 20\n')
  })

  it('同一文件的多处改动按顺序应用', async () => {
    const a = seed(ws, 'a.ts', 'one\ntwo\n')
    await withWorkspace(ws, 'ap-2', async () => {
      const res = await patch({
        changes: [{ path: a, edits: [
          { old_string: 'one', new_string: 'ONE' },
          { old_string: 'two', new_string: 'TWO' },
        ] }],
      })
      expect(res.success, res.error).toBe(true)
    })
    expect(fs.readFileSync(a, 'utf-8')).toBe('ONE\nTWO\n')
  })

  it('content 新建文件并自动创建父目录', async () => {
    const target = path.join(ws, 'new', 'dir', 'x.txt')
    await withWorkspace(ws, 'ap-3', async () => {
      const res = await patch({ changes: [{ path: target, content: 'hello' }] })
      expect(res.success, res.error).toBe(true)
    })
    expect(fs.readFileSync(target, 'utf-8')).toBe('hello')
  })

  it('插入与删除通过替换完成（原 file_edit insert/delete 的等价写法）', async () => {
    const a = seed(ws, 'a.txt', 'line1\nANCHOR\nline3\nREMOVE\n')
    await withWorkspace(ws, 'ap-3b', async () => {
      const res = await patch({
        changes: [{ path: a, edits: [
          { old_string: 'ANCHOR\n', new_string: 'ANCHOR\nINSERTED\n' },
          { old_string: 'REMOVE\n', new_string: '' },
        ] }],
      })
      expect(res.success, res.error).toBe(true)
    })
    expect(fs.readFileSync(a, 'utf-8')).toBe('line1\nANCHOR\nINSERTED\nline3\n')
  })

  it('原子性：任一改动失败则整体拒绝，已改文件不被写入', async () => {
    const a = seed(ws, 'a.ts', 'const a = 1\n')
    const b = seed(ws, 'b.ts', 'const b = 2\n')

    await withWorkspace(ws, 'ap-4', async () => {
      const res = await patch({
        changes: [
          { path: a, edits: [{ old_string: 'const a = 1', new_string: 'const a = 10' }] },
          { path: b, edits: [{ old_string: 'NOT_PRESENT', new_string: 'x' }] },
        ],
      })
      expect(res.success).toBe(false)
      expect(res.error).toContain('未找到匹配文本')
    })
    expect(fs.readFileSync(a, 'utf-8')).toBe('const a = 1\n')
    expect(fs.readFileSync(b, 'utf-8')).toBe('const b = 2\n')
  })

  it('不唯一匹配时提示补充上下文或 replace_all', async () => {
    const a = seed(ws, 'a.ts', 'foo bar foo\n')
    await withWorkspace(ws, 'ap-5', async () => {
      const res = await patch({ changes: [{ path: a, edits: [{ old_string: 'foo', new_string: 'x' }] }] })
      expect(res.success).toBe(false)
      expect(res.error).toContain('不唯一')
    })
  })

  it('参数校验：空 changes、同文件重复、edits 与 content 并存、缺少两者', async () => {
    const a = seed(ws, 'a.ts', 'x\n')
    await withWorkspace(ws, 'ap-6', async () => {
      expect((await patch({ changes: [] })).error).toContain('changes 不能为空')
      expect((await patch({ changes: [{ path: a, content: 'x' }, { path: a, content: 'y' }] })).error).toContain('出现多次')
      expect((await patch({ changes: [{ path: a, edits: [{ old_string: 'x', new_string: 'y' }], content: 'y' }] })).error)
        .toContain('edits 与 content 只能二选一')
      expect((await patch({ changes: [{ path: a }] })).error).toContain('必须提供 edits 或 content')
    })
  })

  it('无实际改动时拒绝：edits 结果与原文一致 / content 与现有内容相同', async () => {
    const a = seed(ws, 'a.ts', 'same\n')
    await withWorkspace(ws, 'ap-7', async () => {
      expect((await patch({ changes: [{ path: a, edits: [{ old_string: 'same', new_string: 'same' }] }] })).error)
        .toContain('old_string 与 new_string 相同')
      expect((await patch({ changes: [{ path: a, content: 'same\n' }] })).error).toContain('未产生改动')
    })
  })

  it('二进制文件拒绝覆盖（避免静默损坏）', async () => {
    const bin = path.join(ws, 'bin.dat')
    fs.writeFileSync(bin, Buffer.from([0x01, 0x00, 0x02]))
    await withWorkspace(ws, 'ap-8', async () => {
      const res = await patch({ changes: [{ path: bin, content: 'text' }] })
      expect(res.success).toBe(false)
      expect(res.error).toContain('无法安全覆盖')
    })
    expect(fs.readFileSync(bin)).toEqual(Buffer.from([0x01, 0x00, 0x02]))
  })

  it('edits 指向不存在的文件时提示改用 content 或 file_write', async () => {
    await withWorkspace(ws, 'ap-9', async () => {
      const res = await patch({ changes: [{ path: path.join(ws, 'nope.ts'), edits: [{ old_string: 'a', new_string: 'b' }] }] })
      expect(res.success).toBe(false)
      expect(res.error).toContain('文件不存在')
    })
  })

  it('工作区外修改被拒绝且不落盘', async () => {
    const outside = makeTemp('wa-ap-out-')
    try {
      const target = path.join(outside, 'x.ts')
      fs.writeFileSync(target, 'orig\n', 'utf-8')
      await withWorkspace(ws, 'ap-10', async () => {
        const res = await patch({ changes: [{ path: target, edits: [{ old_string: 'orig', new_string: 'changed' }] }] })
        expect(res.success).toBe(false)
      })
      expect(fs.readFileSync(target, 'utf-8')).toBe('orig\n')
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('超过单次文件数上限时报错', async () => {
    const changes = Array.from({ length: 51 }, (_, i) => ({ path: path.join(ws, `f${i}.ts`), content: 'x' }))
    await withWorkspace(ws, 'ap-11', async () => {
      expect((await patch({ changes })).error).toContain('一次最多修改 50 个文件')
    })
  })

  it('工具元信息：常驻、需确认、自授权、不重试、changes 必填', () => {
    expect(filesEditTool.id).toBe('files_edit')
    expect(filesEditTool.onDemand).toBe(false)
    expect(filesEditTool.permission).toBe('requires_confirmation')
    expect(filesEditTool.selfAuthorized).toBe(true)
    expect(filesEditTool.noRetry).toBe(true)
    expect(filesEditTool.timeoutMs).toBe(305000)
    expect(filesEditTool.parameters.required).toEqual(['changes'])
  })
})

describe('agent/tools/env-probe', () => {
  it('工具元信息：按需、只读、无参数、不重试', () => {
    expect(envProbeTool.id).toBe('env_probe')
    expect(envProbeTool.onDemand).toBe(true)
    expect(envProbeTool.permission).toBe('safe')
    expect(envProbeTool.noRetry).toBe(true)
    expect(envProbeTool.parameters.required).toEqual([])
    expect(Object.keys(envProbeTool.parameters.properties)).toEqual([])
  })

  it.runIf(process.platform === 'win32')('真实探测返回环境与工具清单', async () => {
    const ws = makeTemp('wa-ep-')
    try {
      const res = await withWorkspace(ws, 'ep-1', async () => {
        return envProbeTool.handler!({}) as Promise<ToolResult>
      })
      expect(res.success, res.error).toBe(true)
      expect(res.output).toContain('# 环境探测')
      expect(res.output).toContain('Node.js')
      expect(res.output).toMatch(/## 已安装的命令行工具\n- node: /)
    } finally {
      fs.rmSync(ws, { recursive: true, force: true })
    }
  }, 60_000)
})
