import { describe, it, expect, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { parseHeredoc, runCommandPlatform, truncateOutput, IS_WINDOWS } from '../../../electron/main/services/agent/tools/exec-shared'

/** 补充 exec-shared 未覆盖分支（stdin 语义见 exec-shared/stdin.test.ts） */

describe('agent/tools/exec-shared / parseHeredoc', () => {
  it('无 heredoc 时返回 null', () => {
    expect(parseHeredoc('echo hello')).toBeNull()
    expect(parseHeredoc('node script.js')).toBeNull()
  })

  it('解析未加引号的分隔符，返回前置命令与正文', () => {
    const r = parseHeredoc('cat <<EOF\nline1\nline2\nEOF')
    expect(r).toEqual({ preCommand: 'cat', heredocBody: 'line1\nline2', shell: 'cat' })
  })

  it('单/双引号分隔符均可解析', () => {
    expect(parseHeredoc("python - <<'PY'\nprint(1)\nPY")?.heredocBody).toBe('print(1)')
    expect(parseHeredoc('python - <<"PY"\nprint(1)\nPY')?.heredocBody).toBe('print(1)')
    expect(parseHeredoc("python - <<'PY'\nprint(1)\nPY")?.preCommand).toBe('python -')
  })

  it('分隔符大小写不敏感（正则带 /i 标志，[A-Z_] 实际为 [A-Za-z_]）', () => {
    expect(parseHeredoc('cat <<eof\nbody\neof')?.heredocBody).toBe('body')
  })

  it('分隔符后存在多余内容时不匹配（必须位于命令末尾）', () => {
    expect(parseHeredoc('cat <<EOF\nbody\nEOF\n echo done')).toBeNull()
  })

  it('兼容 CRLF 换行', () => {
    expect(parseHeredoc('cat <<EOF\r\nbody\r\nEOF')?.heredocBody).toBe('body')
  })

  it('正文中出现与分隔符相同的中间行时仍取最后一个分隔符', () => {
    expect(parseHeredoc('cat <<EOF\na\nEOF\nb\nEOF')?.heredocBody).toBe('a\nEOF\nb')
  })

  it('空正文（分隔符紧跟空行）可解析；缺少终止行时返回 null', () => {
    expect(parseHeredoc('cat <<EOF\n\nEOF')?.heredocBody).toBe('')
    expect(parseHeredoc('python - <<PY\nPY')).toBeNull()
  })
})

describe('agent/tools/exec-shared / truncateOutput', () => {
  it('空串/短文本原样返回', () => {
    expect(truncateOutput('', 10)).toBe('')
    expect(truncateOutput('abc', 10)).toBe('abc')
    expect(truncateOutput('0123456789', 10)).toBe('0123456789')
  })

  it('超长文本保留首尾各半并标注截断长度', () => {
    const text = `${'A'.repeat(50)}${'B'.repeat(50)}`
    const out = truncateOutput(text, 10)
    expect(out.startsWith('AAAAA')).toBe(true)
    expect(out.endsWith('BBBBB')).toBe(true)
    expect(out).toContain('(中间 90 字符已截断)')
    expect(out.length).toBeLessThan(text.length)
  })

  it('maxChars=0 时只返回截断标记（边界）', () => {
    const out = truncateOutput('abcdef', 0)
    expect(out).toContain('(中间 6 字符已截断)')
    expect(out).not.toContain('a')
    expect(out).not.toContain('f')
  })

  it('截断点落在代理对中间时回退 1 个码元，不再产生孤立高代理', () => {
    const emoji = '😀'.repeat(50) // 100 个 UTF-16 码元
    const out = truncateOutput(emoji, 10)
    // half=5 → 第 5 个码元是第三个 emoji 的高代理，回退后前缀只剩 2 个完整 emoji
    const head = out.split('\n\n')[0]
    expect(head).toBe('😀😀')
    expect(/[\uD800-\uDBFF]$/.test(head)).toBe(false)
  })
})

const tempFiles: string[] = []

afterAll(() => {
  for (const f of tempFiles) {
    try { fs.rmSync(f, { force: true }) } catch { /* ignore */ }
  }
})

/** 用 `node <脚本路径>` 执行（临时目录路径无空格，避免 shell 引号差异） */
function nodeScript(code: string): string {
  const file = path.join(os.tmpdir(), `wa-exec-${process.pid}-${tempFiles.length}.js`)
  fs.writeFileSync(file, code, 'utf-8')
  tempFiles.push(file)
  return `node ${file}`
}

describe('agent/tools/exec-shared / runCommandPlatform', () => {
  it('正常执行：退出码 0 且 stdout 可用', async () => {
    const res = await runCommandPlatform(nodeScript('console.log("OUT-OK")'), { cwd: os.tmpdir(), timeoutMs: 20000 })
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('OUT-OK')
    expect(res.signal).toBeNull()
  }, 30000)

  it('stdout 与 stderr 严格分离，非零退出码原样返回', async () => {
    const res = await runCommandPlatform(
      nodeScript('console.log("TO-STDOUT"); console.error("TO-STDERR"); process.exit(3)'),
      { cwd: os.tmpdir(), timeoutMs: 20000 },
    )
    expect(res.code).toBe(3)
    expect(res.stdout).toContain('TO-STDOUT')
    expect(res.stdout).not.toContain('TO-STDERR')
    expect(res.stderr).toContain('TO-STDERR')
    expect(res.stderr).not.toContain('TO-STDOUT')
  }, 30000)

  it('extraEnv 注入到子进程环境', async () => {
    const res = await runCommandPlatform(nodeScript('console.log("ENV=" + process.env.WA_TEST_ENV)'), {
      cwd: os.tmpdir(),
      timeoutMs: 20000,
      extraEnv: { WA_TEST_ENV: 'injected-value' },
    })
    expect(res.stdout).toContain('ENV=injected-value')
  }, 30000)

  it('UTF-8 中文输出正确解码（不出现乱码）', async () => {
    const res = await runCommandPlatform(nodeScript('console.log("中文输出测试")'), { cwd: os.tmpdir(), timeoutMs: 20000 })
    expect(res.stdout).toContain('中文输出测试')
  }, 30000)

  it('cwd 不存在时不抛异常，收敛为 code -1 与错误信息', async () => {
    const missing = path.join(os.tmpdir(), `wa-no-such-dir-${process.pid}`)
    const res = await runCommandPlatform('echo hi', { cwd: missing, timeoutMs: 10000 })
    expect(res.code).toBe(-1)
    expect(res.stderr.length).toBeGreaterThan(0)
    expect(res.stdout).toBe('')
  }, 30000)

  it('超时后杀死进程并返回 code -2 / SIGKILL', async () => {
    const started = Date.now()
    const res = await runCommandPlatform(nodeScript('setTimeout(() => console.log("SHOULD-NOT-PRINT"), 4000)'), {
      cwd: os.tmpdir(),
      timeoutMs: 300,
    })
    expect(res.code).toBe(-2)
    expect(res.signal).toBe('SIGKILL')
    expect(res.stdout).not.toContain('SHOULD-NOT-PRINT')
    // killTimer 在 timeoutMs + 500 触发
    expect(Date.now() - started).toBeLessThan(6000)
  }, 30000)

  it.skipIf(!IS_WINDOWS)('超长命令（>8000 字符）写入临时脚本文件后仍可执行', async () => {
    const command = `# ${'x'.repeat(9000)}\nWrite-Output LONG-OK`
    expect(command.length).toBeGreaterThan(8000)
    const res = await runCommandPlatform(command, { cwd: os.tmpdir(), timeoutMs: 30000 })
    expect(res.stdout).toContain('LONG-OK')
  }, 40000)

  it('IS_WINDOWS 常量与运行平台一致', () => {
    expect(IS_WINDOWS).toBe(process.platform === 'win32')
  })
})
