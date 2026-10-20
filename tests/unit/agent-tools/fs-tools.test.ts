import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { interactionContext } from '../../../electron/main/services/unified-interaction.service'
import UnifiedInteractionService from '../../../electron/main/services/unified-interaction.service'
import {
  fileWriteTool,
  reportGeneratedFilesTool,
} from '../../../electron/main/services/agent/tools/fs-tools'

/**
 * file_write / report_generated_files 的分支覆盖
 * （file_read 与 file_delete 见 deletion-policy.test.ts，files_edit 见 programming-tools.test.ts）。
 *
 * 注意：file_write 的路径解析用 path.resolve(相对路径)（即主进程 cwd），
 * 与 file_delete / report_generated_files 的「相对路径按工作区解析」不一致，
 * 因此本文件对需要成功的用例统一传绝对路径，并单独覆盖相对路径的现行行为。
 */

type ToolResult = { success: boolean; output?: any; error?: string; generatedFiles?: any[] }

function makeTemp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function withWorkspace<T>(ws: string, sessionId: string, fn: () => Promise<T> | T, highPermission = false): Promise<T> {
  return interactionContext.run(
    { sessionId, employeeId: 'e1', workspacePath: ws, highPermission } as never,
    async () => fn(),
  ) as Promise<T>
}

const write = (args: any): Promise<ToolResult> => fileWriteTool.handler!(args) as Promise<ToolResult>
const report = (args: any): Promise<ToolResult> => reportGeneratedFilesTool.handler!(args) as Promise<ToolResult>

describe('agent/tools/fs-tools / file_write', () => {
  let ws: string
  let outside: string

  beforeEach(() => {
    ws = makeTemp('wa-fw-ws-')
    outside = makeTemp('wa-fw-out-')
  })
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  it('路径为空（含纯空白）时报错', async () => {
    await withWorkspace(ws, 'fw-1', async () => {
      expect(await write({ path: '', content: 'x' })).toMatchObject({ success: false, error: '文件路径不能为空' })
      expect(await write({ path: '   ', content: 'x' })).toMatchObject({ success: false, error: '文件路径不能为空' })
    })
  })

  it('工作区内写入：自动创建父目录并回显字符数', async () => {
    const target = path.join(ws, 'sub', 'dir', 'a.txt')
    await withWorkspace(ws, 'fw-2', async () => {
      const res = await write({ path: target, content: 'hello' })
      expect(res.success, res.error).toBe(true)
      expect(res.output).toContain('成功写入')
      expect(res.output).toContain('共 5 字符')
    })
    expect(fs.readFileSync(target, 'utf-8')).toBe('hello')
  })

  it('已有内容默认覆盖，append=true 时追加', async () => {
    const target = path.join(ws, 'a.txt')
    await withWorkspace(ws, 'fw-3', async () => {
      await write({ path: target, content: 'AAA' })
      await write({ path: target, content: 'BBB' })
      expect(fs.readFileSync(target, 'utf-8')).toBe('BBB')

      await write({ path: target, content: 'CCC', append: true })
      expect(fs.readFileSync(target, 'utf-8')).toBe('BBBCCC')
      expect((await write({ path: target, content: 'D', append: true })).output).toContain('成功追加')
    })
  })

  it('append 仅严格 true 生效（字符串 "true" 走覆盖）', async () => {
    const target = path.join(ws, 'a.txt')
    await withWorkspace(ws, 'fw-4', async () => {
      await write({ path: target, content: 'X' })
      await write({ path: target, content: 'Y', append: 'true' })
    })
    expect(fs.readFileSync(target, 'utf-8')).toBe('Y')
  })

  it('content 非字符串被 String() 转换；0 等假值写成空内容', async () => {
    await withWorkspace(ws, 'fw-5', async () => {
      const num = path.join(ws, 'num.txt')
      await write({ path: num, content: 123 })
      expect(fs.readFileSync(num, 'utf-8')).toBe('123')

      const zero = path.join(ws, 'zero.txt')
      await write({ path: zero, content: 0 })
      expect(fs.readFileSync(zero, 'utf-8')).toBe('')

      const obj = path.join(ws, 'obj.txt')
      await write({ path: obj, content: { a: 1 } })
      expect(fs.readFileSync(obj, 'utf-8')).toBe('[object Object]')
    })
  })

  it('空文件写入同样成功（内容为 0 字符）', async () => {
    const target = path.join(ws, 'empty.txt')
    await withWorkspace(ws, 'fw-5b', async () => {
      const res = await write({ path: target, content: '' })
      expect(res.success).toBe(true)
      expect(res.output).toContain('共 0 字符')
    })
    expect(fs.existsSync(target)).toBe(true)
  })

  it('写入工作区外：无授权时被拒绝且不创建文件', async () => {
    const target = path.join(outside, 'secret.txt')
    await withWorkspace(ws, 'fw-6', async () => {
      const res = await write({ path: target, content: 'x' })
      expect(res.success).toBe(false)
      expect(res.error).toContain('用户取消了写入工作区外文件的操作')
    })
    expect(fs.existsSync(target)).toBe(false)
  })

  it('任务级高权限下工作区外写入直接放行', async () => {
    const target = path.join(outside, 'allowed.txt')
    UnifiedInteractionService.getInstance().setTaskHighPermission('fw-7', true)
    try {
      await withWorkspace(ws, 'fw-7', async () => {
        const res = await write({ path: target, content: 'ok' })
        expect(res.success, res.error).toBe(true)
      })
    } finally {
      UnifiedInteractionService.getInstance().setTaskHighPermission('fw-7', false)
    }
    expect(fs.readFileSync(target, 'utf-8')).toBe('ok')
  })

  it('无交互上下文时即使路径在工作区内也被拒绝（后台任务不解锁写入）', async () => {
    const target = path.join(ws, 'no-ctx.txt')
    const res = await write({ path: target, content: 'x' })
    expect(res.success).toBe(false)
    expect(res.error).toContain('无交互上下文')
    expect(fs.existsSync(target)).toBe(false)
  })

  it('相对路径按工作区解析（不是主进程 cwd）', async () => {
    const relName = `wa-fw-rel-${process.pid}.txt`
    const cwdTarget = path.resolve(relName)
    await withWorkspace(ws, 'fw-8', async () => {
      const res = await write({ path: relName, content: 'x' })
      expect(res.success, res.error).toBe(true)
    })
    // 落到工作区，主进程 cwd 不被污染
    expect(fs.readFileSync(path.join(ws, relName), 'utf-8')).toBe('x')
    expect(fs.existsSync(cwdTarget)).toBe(false)
  })

  it('工具元信息：不重试、超时覆盖交互超时', () => {
    expect(fileWriteTool.noRetry).toBe(true)
    expect(fileWriteTool.timeoutMs).toBe(300000 + 5000)
    expect(fileWriteTool.parameters.required).toEqual(['path', 'content'])
    expect(fileWriteTool.onDemand).toBeFalsy()
  })
})

describe('agent/tools/fs-tools / report_generated_files', () => {
  let ws: string

  beforeEach(() => {
    ws = makeTemp('wa-rgf-')
  })
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true })
  })

  it('files 非数组或为空时报错', async () => {
    await withWorkspace(ws, 'rgf-1', async () => {
      for (const files of [undefined, null, [], 'a.docx', 0]) {
        expect(await report({ files })).toMatchObject({ success: false, error: '参数 files 不能为空' })
      }
    })
  })

  it('声明白名单内的成品文件：返回完整元信息', async () => {
    const p = path.join(ws, '报告.docx')
    fs.writeFileSync(p, 'x'.repeat(10), 'utf-8')
    await withWorkspace(ws, 'rgf-2', async () => {
      const res = await report({ files: [p] })
      expect(res.success).toBe(true)
      expect(res.output).toContain('已声明 1 个成品文件')
      expect(res.output).toContain(`  ✓ ${p}`)
      expect(res.generatedFiles![0]).toMatchObject({ path: p, name: '报告.docx', ext: 'docx', size: 10 })
      expect(typeof res.generatedFiles![0].mtime).toBe('number')
    })
  })

  it('过滤不存在/目录/非白名单扩展名/无扩展名，并列出被过滤项', async () => {
    const keep = path.join(ws, 'keep.md')
    fs.writeFileSync(keep, '# t', 'utf-8')
    const exe = path.join(ws, 'tool.exe')
    fs.writeFileSync(exe, 'bin', 'utf-8')
    const noExt = path.join(ws, 'LICENSE')
    fs.writeFileSync(noExt, 'x', 'utf-8')
    const dir = path.join(ws, 'sub')
    fs.mkdirSync(dir)

    await withWorkspace(ws, 'rgf-3', async () => {
      const res = await report({ files: [keep, exe, noExt, dir, path.join(ws, 'missing.pdf')] })
      expect(res.success).toBe(true)
      expect(res.generatedFiles!.map(f => f.name)).toEqual(['keep.md'])
      expect(res.output).toContain('已过滤（不存在/非文件/扩展名不在白名单）4 个：')
      expect(res.output).toContain(`  ✗ ${exe}`)
      expect(res.output).toContain(`  ✗ ${dir}`)
    })
  })

  it('相对路径按工作区解析；非字符串项被静默跳过（不计入过滤统计）', async () => {
    fs.writeFileSync(path.join(ws, 'rel.xlsx'), 'x', 'utf-8')
    await withWorkspace(ws, 'rgf-4', async () => {
      const res = await report({ files: ['rel.xlsx', null, 123, '   '] })
      expect(res.success).toBe(true)
      expect(res.generatedFiles!.map(f => f.path)).toEqual([path.join(ws, 'rel.xlsx')])
      expect(res.output).not.toContain('已过滤')
    })
  })

  it('扩展名大小写不敏感（.DOCX 视为 docx）', async () => {
    const p = path.join(ws, 'UPPER.DOCX')
    fs.writeFileSync(p, 'x', 'utf-8')
    await withWorkspace(ws, 'rgf-5', async () => {
      const res = await report({ files: [p] })
      expect(res.generatedFiles![0].ext).toBe('docx')
    })
  })

  it('无工作区上下文时相对路径退回进程 cwd（不报错）', async () => {
    const res = await report({ files: ['definitely-missing-file.docx'] })
    expect(res.success).toBe(true)
    expect(res.generatedFiles).toEqual([])
    expect(res.output).toContain('已过滤')
  })

  it('空数组内所有项被过滤时仍返回成功（不抛错）', async () => {
    await withWorkspace(ws, 'rgf-6', async () => {
      const res = await report({ files: ['', '   ', path.join(ws, 'nope.txt')] })
      expect(res.success).toBe(true)
      expect(res.generatedFiles).toEqual([])
      expect(res.output).toContain('已声明 0 个成品文件')
    })
  })

  it('工具元信息：常驻、不重试、files 必填', () => {
    expect(reportGeneratedFilesTool.id).toBe('report_generated_files')
    expect(reportGeneratedFilesTool.onDemand).toBeFalsy()
    expect(reportGeneratedFilesTool.noRetry).toBe(true)
    expect(reportGeneratedFilesTool.permission).toBe('safe')
    expect(reportGeneratedFilesTool.parameters.required).toEqual(['files'])
  })
})
