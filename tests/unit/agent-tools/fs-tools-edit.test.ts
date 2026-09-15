import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { interactionContext } from '../../../electron/main/services/unified-interaction.service'
import UnifiedInteractionService from '../../../electron/main/services/unified-interaction.service'
import {
  fileEditTool,
  fileWriteTool,
  reportGeneratedFilesTool,
} from '../../../electron/main/services/agent/tools/fs-tools'

/**
 * file_write / file_edit / report_generated_files 的分支覆盖
 * （file_read 回归与 file_delete 见 deletion-policy.test.ts）。
 *
 * 注意：file_write / file_edit 的路径解析用 path.resolve(相对路径)（即主进程 cwd），
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
const edit = (args: any): Promise<ToolResult> => fileEditTool.handler!(args) as Promise<ToolResult>
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

describe('agent/tools/fs-tools / file_edit', () => {
  let ws: string

  beforeEach(() => {
    ws = makeTemp('wa-fe-ws-')
  })
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true })
  })

  const seed = (name: string, content: string) => {
    const p = path.join(ws, name)
    fs.writeFileSync(p, content, 'utf-8')
    return p
  }

  it('operation 缺失或未知时报错并回显操作名', async () => {
    const p = seed('a.txt', 'x')
    await withWorkspace(ws, 'fe-1', async () => {
      expect(await edit({ path: p })).toMatchObject({ success: false, error: '不支持的 operation: （可用 replace/insert/delete）' })
      expect(await edit({ operation: 'Replace', path: p })).toMatchObject({ success: false, error: '不支持的 operation: Replace（可用 replace/insert/delete）' })
    })
  })

  it('路径为空 / 文件不存在 / 路径是目录分别报错', async () => {
    const dir = path.join(ws, 'adir')
    fs.mkdirSync(dir)
    await withWorkspace(ws, 'fe-2', async () => {
      expect(await edit({ operation: 'replace', path: '', old_string: 'a', new_string: 'b' }))
        .toMatchObject({ success: false, error: '文件路径不能为空' })

      const missing = await edit({ operation: 'replace', path: path.join(ws, 'nope.txt'), old_string: 'a', new_string: 'b' })
      expect(missing.success).toBe(false)
      expect(missing.error).toContain('文件不存在')
      expect(missing.error).toContain('file_write')

      expect(await edit({ operation: 'replace', path: dir, old_string: 'a', new_string: 'b' }))
        .toMatchObject({ success: false, error: `路径不是文件: ${dir}` })
    })
  })

  it('相对路径按工作区解析：工作区内同名文件会被命中', async () => {
    seed('rel.txt', 'content')
    await withWorkspace(ws, 'fe-2b', async () => {
      const res = await edit({ operation: 'replace', path: 'rel.txt', old_string: 'content', new_string: 'changed' })
      expect(res.success, res.error).toBe(true)
    })
    expect(fs.readFileSync(path.join(ws, 'rel.txt'), 'utf-8')).toBe('changed')
  })

  it('replace：old_string 为空或与 new_string 相同时拒绝（且不改动文件）', async () => {
    const p = seed('a.txt', 'hello world')
    await withWorkspace(ws, 'fe-3', async () => {
      expect(await edit({ operation: 'replace', path: p, old_string: '', new_string: 'x' }))
        .toMatchObject({ success: false, error: 'old_string 不能为空' })
      expect(await edit({ operation: 'replace', path: p, old_string: 'hello', new_string: 'hello' }))
        .toMatchObject({ success: false, error: 'old_string 与 new_string 相同，无需替换' })
    })
    expect(fs.readFileSync(p, 'utf-8')).toBe('hello world')
  })

  it('replace：未匹配 / 多处匹配未开启 replace_all 时报错', async () => {
    const p = seed('a.txt', 'foo bar foo')
    await withWorkspace(ws, 'fe-4', async () => {
      expect(await edit({ operation: 'replace', path: p, old_string: 'zzz', new_string: 'x' }))
        .toMatchObject({ success: false, error: '未找到匹配文本。请检查 old_string 是否精确匹配文件内容（含缩进/空格/换行）' })
      const dup = await edit({ operation: 'replace', path: p, old_string: 'foo', new_string: 'x' })
      expect(dup.success).toBe(false)
      expect(dup.error).toContain('匹配 2 处，不唯一')
      expect(dup.error).toContain('replace_all=true')
    })
  })

  it('replace：唯一匹配只替换一次；replace_all=true 全部替换并回显处数', async () => {
    const p = seed('a.txt', 'foo bar foo')
    await withWorkspace(ws, 'fe-5', async () => {
      const once = await edit({ operation: 'replace', path: p, old_string: 'bar', new_string: 'BAR' })
      expect(once.success).toBe(true)
      expect(once.output).toContain('替换 1 处')

      const all = await edit({ operation: 'replace', path: p, old_string: 'foo', new_string: 'X', replace_all: true })
      expect(all.success).toBe(true)
      expect(all.output).toContain('替换 2 处')
    })
    expect(fs.readFileSync(p, 'utf-8')).toBe('X BAR X')
  })

  it('replace：new_string 为空即删除该文本', async () => {
    const p = seed('a.txt', 'keep REMOVE keep')
    await withWorkspace(ws, 'fe-6', async () => {
      expect((await edit({ operation: 'replace', path: p, old_string: 'REMOVE ', new_string: '' })).success).toBe(true)
    })
    expect(fs.readFileSync(p, 'utf-8')).toBe('keep keep')
  })

  it('replace：替换文本中的 $& / $1 / $` 等不被当作替换模式解释（回归）', async () => {
    const p = seed('a.txt', 'PLACEHOLDER')
    await withWorkspace(ws, 'fe-7', async () => {
      const res = await edit({ operation: 'replace', path: p, old_string: 'PLACEHOLDER', new_string: '$& $1 $` $\'' })
      expect(res.success).toBe(true)
    })
    expect(fs.readFileSync(p, 'utf-8')).toBe('$& $1 $` $\'')
  })

  it('replace_all=true 但内容不含 old_string 时报未找到', async () => {
    const p = seed('a.txt', 'abc')
    await withWorkspace(ws, 'fe-8', async () => {
      const res = await edit({ operation: 'replace', path: p, old_string: 'zzz', new_string: 'y', replace_all: true })
      expect(res.success).toBe(false)
      expect(res.error).toContain('未找到匹配文本')
    })
  })

  it('insert：content 为空时报错', async () => {
    const p = seed('a.txt', 'x')
    await withWorkspace(ws, 'fe-9', async () => {
      expect(await edit({ operation: 'insert', path: p, content: '' }))
        .toMatchObject({ success: false, error: 'content 不能为空' })
    })
  })

  it('insert：after_string 优先于 line，未找到时报错', async () => {
    const p = seed('a.txt', 'line1\nANCHOR\nline3')
    await withWorkspace(ws, 'fe-10', async () => {
      const notFound = await edit({ operation: 'insert', path: p, content: 'X', after_string: 'NOPE', line: 1 })
      expect(notFound.success).toBe(false)
      expect(notFound.error).toContain('after_string 未在文件中找到')

      const res = await edit({ operation: 'insert', path: p, content: '\nX', after_string: 'ANCHOR', line: 3 })
      expect(res.success).toBe(true)
      expect(res.output).toContain('在指定文本后')
    })
    expect(fs.readFileSync(p, 'utf-8')).toBe('line1\nANCHOR\nX\nline3')
  })

  it('insert：line=1 插到首行；line 超出范围报错（可插入范围 1~lines+1）', async () => {
    const p = seed('a.txt', 'one\ntwo')
    await withWorkspace(ws, 'fe-11', async () => {
      expect((await edit({ operation: 'insert', path: p, content: 'zero', line: 1 })).output).toContain('在第 1 行前')
      const tooBig = await edit({ operation: 'insert', path: p, content: 'x', line: 10 })
      expect(tooBig.success).toBe(false)
      expect(tooBig.error).toContain('超出文件总行数 3（可插入范围 1~4）')

      // 边界：正好 lines+1 行可插入
      expect((await edit({ operation: 'insert', path: p, content: 'tail', line: 4 })).success).toBe(true)
    })
    expect(fs.readFileSync(p, 'utf-8')).toBe('zero\none\ntwo\ntail')
  })

  it('insert：line=0 走追加末尾，且自动补换行', async () => {
    const p = seed('a.txt', 'body')
    await withWorkspace(ws, 'fe-12', async () => {
      expect((await edit({ operation: 'insert', path: p, content: 'end', line: 0 })).output).toContain('在文件末尾')
    })
    expect(fs.readFileSync(p, 'utf-8')).toBe('body\nend')

    const p2 = seed('b.txt', 'body\n')
    await withWorkspace(ws, 'fe-12', async () => {
      await edit({ operation: 'insert', path: p2, content: 'end' })
    })
    expect(fs.readFileSync(p2, 'utf-8')).toBe('body\nend')
  })

  it('insert：省略 line 与 after_string 时追加到末尾', async () => {
    const p = seed('a.txt', 'body')
    await withWorkspace(ws, 'fe-12b', async () => {
      expect((await edit({ operation: 'insert', path: p, content: 'tail' })).output).toContain('在文件末尾')
    })
    expect(fs.readFileSync(p, 'utf-8')).toBe('body\ntail')
  })

  it('delete：old_string 唯一时精确删除；未找到/不唯一时报错', async () => {
    const p = seed('a.txt', 'a\nDELETE\nb')
    await withWorkspace(ws, 'fe-13', async () => {
      expect(await edit({ operation: 'delete', path: p, old_string: 'nope' }))
        .toMatchObject({ success: false, error: 'old_string 未在文件中找到' })
      expect((await edit({ operation: 'delete', path: p, old_string: 'DELETE\n' })).success).toBe(true)
    })
    expect(fs.readFileSync(p, 'utf-8')).toBe('a\nb')
  })

  it('delete：old_string 多处匹配时拒绝', async () => {
    const p = seed('a.txt', 'x x')
    await withWorkspace(ws, 'fe-14', async () => {
      const res = await edit({ operation: 'delete', path: p, old_string: 'x' })
      expect(res.success).toBe(false)
      expect(res.error).toContain('匹配 2 处，不唯一')
    })
  })

  it('delete：行范围校验（缺参/负数/倒序/越界/自动裁剪）', async () => {
    const p = seed('a.txt', 'l1\nl2\nl3\nl4')
    await withWorkspace(ws, 'fe-15', async () => {
      expect(await edit({ operation: 'delete', path: p }))
        .toMatchObject({ success: false, error: '请提供 old_string 或 start_line+end_line 来指定删除范围' })
      expect(await edit({ operation: 'delete', path: p, start_line: 0, end_line: 1 }))
        .toMatchObject({ success: false, error: 'start_line 和 end_line 必须 ≥ 1' })
      expect(await edit({ operation: 'delete', path: p, start_line: 3, end_line: 1 }))
        .toMatchObject({ success: false, error: 'start_line(3) 不能大于 end_line(1)' })
      expect(await edit({ operation: 'delete', path: p, start_line: 9, end_line: 10 }))
        .toMatchObject({ success: false, error: 'start_line 9 超出文件总行数 4' })

      // end_line 超出时自动裁剪到末行
      const res = await edit({ operation: 'delete', path: p, start_line: 3, end_line: 99 })
      expect(res.success).toBe(true)
      expect(res.output).toContain('删除第 3-4 行（共 2 行）')
    })
    expect(fs.readFileSync(p, 'utf-8')).toBe('l1\nl2')
  })

  it('delete：只传 start_line 不传 end_line 视为未指定范围', async () => {
    const p = seed('a.txt', 'a\nb')
    await withWorkspace(ws, 'fe-16', async () => {
      const res = await edit({ operation: 'delete', path: p, start_line: 1 })
      expect(res.success).toBe(false)
      expect(res.error).toContain('请提供 old_string 或 start_line+end_line')
    })
  })

  it('CRLF 文件读取时归一为 LF，写回后保持 LF', async () => {
    const p = path.join(ws, 'crlf.txt')
    fs.writeFileSync(p, 'a\r\nb\r\n', 'utf-8')
    await withWorkspace(ws, 'fe-17', async () => {
      const res = await edit({ operation: 'replace', path: p, old_string: 'a', new_string: 'A' })
      expect(res.success, res.error).toBe(true)
    })
    expect(fs.readFileSync(p, 'utf-8')).toBe('A\nb\n')
  })

  it('写入工作区外文件被拒绝（编辑同源授权）', async () => {
    const outside = makeTemp('wa-fe-out-')
    try {
      const target = path.join(outside, 'x.txt')
      fs.writeFileSync(target, 'content', 'utf-8')
      await withWorkspace(ws, 'fe-18', async () => {
        const res = await edit({ operation: 'replace', path: target, old_string: 'content', new_string: 'changed' })
        expect(res.success).toBe(false)
        expect(res.error).toContain('用户取消了编辑工作区外文件的操作')
      })
      expect(fs.readFileSync(target, 'utf-8')).toBe('content')
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('工具元信息：不重试、超时覆盖交互超时、operation/path 必填', () => {
    expect(fileEditTool.noRetry).toBe(true)
    expect(fileEditTool.timeoutMs).toBe(305000)
    expect(fileEditTool.parameters.required).toEqual(['operation', 'path'])
    expect(fileEditTool.parameters.properties.operation.enum).toEqual(['replace', 'insert', 'delete'])
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
