/**
 * 脚本执行环境服务单测：
 * - resolveScriptPath 的路径穿越/分隔符防护与脚本清单校验
 * - 扩展名分发（.js/.mjs 用 node 真跑）、未知类型拒绝、脚本缺失拒绝
 * - 输出上限夹取、超时终止、spawn 失败（命令不存在）等错误路径
 * 真实 node 子进程执行（不使用 mock），保证 stdout/stderr/exitCode 语义与运行时一致。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const mockState = vi.hoisted(() => ({
  skills: new Map<string, any>(),
}))

vi.mock('../../../electron/main/services/skill-registry.service', () => ({
  default: {
    getInstance: () => ({
      getSkillById: (id: string) => mockState.skills.get(id) ?? null,
    }),
  },
}))

import SkillExecEnvService from '../../../electron/main/services/skill-exec-env.service'

const MAX_OUTPUT = 100 * 1024

let root = ''
let skillDir = ''

function registerSkill(id: string, scripts: Array<{ name: string; file: string; content?: string }>) {
  fs.mkdirSync(skillDir, { recursive: true })
  const entries = scripts.map((s) => {
    const scriptPath = path.join(skillDir, s.file)
    if (s.content !== undefined) fs.writeFileSync(scriptPath, s.content, 'utf-8')
    return { name: s.name, path: scriptPath, content: s.content ?? '', relPath: s.file }
  })
  mockState.skills.set(id, { id, scripts: entries })
}

const service = SkillExecEnvService.getInstance()

beforeEach(() => {
  mockState.skills.clear()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-exec-test-'))
  skillDir = path.join(root, 'demo-skill')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('skill-exec-env / resolveScriptPath', () => {
  it('skill 不存在返回 null', () => {
    expect(service.resolveScriptPath('nope', 'a.js')).toBeNull()
  })

  it('脚本不在清单中返回 null', () => {
    registerSkill('s1', [{ name: 'run.js', file: 'run.js', content: '' }])
    expect(service.resolveScriptPath('s1', 'other.js')).toBeNull()
  })

  it('命中清单返回绝对路径', () => {
    registerSkill('s2', [{ name: 'run.js', file: 'run.js', content: '' }])
    expect(service.resolveScriptPath('s2', 'run.js')).toBe(path.join(skillDir, 'run.js'))
  })

  it('含路径分隔符或 .. 的脚本名一律拒绝（路径穿越防护）', () => {
    registerSkill('s3', [{ name: '../../evil.js', file: 'evil.js', content: '' }])
    for (const bad of ['../evil.js', '..\\evil.js', 'a/b.js', 'a\\b.js', '..', '../../etc/passwd']) {
      expect(service.resolveScriptPath('s3', bad), bad).toBeNull()
    }
  })

  it('空脚本名在清单无同名条目时返回 null', () => {
    registerSkill('s4', [{ name: 'x.js', file: 'x.js', content: '' }])
    expect(service.resolveScriptPath('s4', '')).toBeNull()
  })

  it('单字符脚本名不触发 .. 误判', () => {
    registerSkill('s4b', [{ name: 'a.js', file: 'a.js', content: '' }])
    expect(service.resolveScriptPath('s4b', 'a.js')).toBe(path.join(skillDir, 'a.js'))
  })

  it('文件名含连续点（合法文件名）不再被误判为路径穿越', () => {
    registerSkill('s4c', [{ name: 'a..b.js', file: 'a..b.js', content: '' }])
    expect(service.resolveScriptPath('s4c', 'a..b.js')).toBe(path.join(skillDir, 'a..b.js'))
  })
})

describe('skill-exec-env / 参数与类型校验', () => {
  it('脚本不存在时返回失败结果且不落盘副作用', async () => {
    registerSkill('s5', [{ name: 'run.js', file: 'run.js', content: '' }])
    const r = await service.executeScript('s5', 'missing.js')
    expect(r).toEqual({
      success: false,
      stdout: '',
      stderr: 'Script "missing.js" not found in skill s5',
      exitCode: null,
      durationMs: 0,
    })
  })

  it('不支持的扩展名直接拒绝（不 spawn）', async () => {
    registerSkill('s6', [{ name: 'run.rb', file: 'run.rb', content: 'puts 1' }])
    const r = await service.executeScript('s6', 'run.rb')
    expect(r.success).toBe(false)
    expect(r.stderr).toContain('Unsupported script type: .rb')
    expect(r.exitCode).toBeNull()
    expect(r.durationMs).toBe(0)
  })

  it('无扩展名脚本视为不支持', async () => {
    registerSkill('s7', [{ name: 'run', file: 'run', content: 'echo hi' }])
    const r = await service.executeScript('s7', 'run')
    expect(r.stderr).toContain('Unsupported script type:')
  })
})

describe('skill-exec-env / node 脚本真实执行', () => {
  it('成功执行：stdout 返回、exitCode=0、durationMs 为正', async () => {
    registerSkill('s8', [
      { name: 'ok.js', file: 'ok.js', content: 'console.log("hello-world")\nconsole.error("warn-line")\n' },
    ])
    const r = await service.executeScript('s8', 'ok.js')
    expect(r.success).toBe(true)
    expect(r.stdout).toBe('hello-world')
    expect(r.stderr).toBe('warn-line')
    expect(r.exitCode).toBe(0)
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('非零退出码 → success=false 并透传 exitCode', async () => {
    registerSkill('s9', [{ name: 'fail.js', file: 'fail.js', content: 'process.exit(3)\n' }])
    const r = await service.executeScript('s9', 'fail.js')
    expect(r.success).toBe(false)
    expect(r.exitCode).toBe(3)
  })

  it('args 透传给脚本（含空格与 Unicode 参数）', async () => {
    registerSkill('s10', [
      { name: 'args.js', file: 'args.js', content: 'console.log(JSON.stringify(process.argv.slice(2)))\n' },
    ])
    const args = ['a b', '中文参数', '--flag=1']
    const r = await service.executeScript('s10', 'args.js', args)
    expect(JSON.parse(r.stdout)).toEqual(args)
  })

  it('args 默认空数组', async () => {
    registerSkill('s11', [
      { name: 'args.js', file: 'args.js', content: 'console.log(process.argv.slice(2).length)\n' },
    ])
    const r = await service.executeScript('s11', 'args.js')
    expect(r.stdout).toBe('0')
  })

  it('脚本 cwd 为脚本所在目录', async () => {
    registerSkill('s12', [
      { name: 'cwd.js', file: 'cwd.js', content: 'console.log(process.cwd())\n' },
    ])
    const r = await service.executeScript('s12', 'cwd.js')
    expect(fs.realpathSync(r.stdout)).toBe(fs.realpathSync(skillDir))
  })

  it('.mjs 同样走 node 执行', async () => {
    registerSkill('s13', [
      { name: 'esm.mjs', file: 'esm.mjs', content: 'console.log("esm-ok")\n' },
    ])
    const r = await service.executeScript('s13', 'esm.mjs')
    expect(r.success).toBe(true)
    expect(r.stdout).toBe('esm-ok')
  })
})

describe('skill-exec-env / 输出上限与超时', () => {
  it('stdout 超过 100KB 时截断到上限并追加截断标记', async () => {
    const chunk = 'x'.repeat(1024 * 1024)
    registerSkill('s14', [
      { name: 'big.js', file: 'big.js', content: `process.stdout.write("${chunk}")\n` },
    ])
    const r = await service.executeScript('s14', 'big.js')
    expect(r.success).toBe(true)
    // 前 100KB 原样保留，其后是明确的截断标记（而非静默丢弃）
    expect(r.stdout.slice(0, MAX_OUTPUT)).toBe('x'.repeat(MAX_OUTPUT))
    expect(r.stdout).toContain(`[输出已截断，仅保留前 ${MAX_OUTPUT} 字符]`)
  })

  it('stderr 同样受上限约束并追加截断标记', async () => {
    const chunk = 'y'.repeat(512 * 1024)
    registerSkill('s15', [
      { name: 'bigerr.js', file: 'bigerr.js', content: `process.stderr.write("${chunk}")\n` },
    ])
    const r = await service.executeScript('s15', 'bigerr.js')
    expect(r.stderr.slice(0, MAX_OUTPUT)).toBe('y'.repeat(MAX_OUTPUT))
    expect(r.stderr).toContain(`[输出已截断，仅保留前 ${MAX_OUTPUT} 字符]`)
  })

  it('输出恰好在阈值内不被截断', async () => {
    registerSkill('s16', [
      { name: 'exact.js', file: 'exact.js', content: `process.stdout.write("z".repeat(${MAX_OUTPUT - 1}))\n` },
    ])
    const r = await service.executeScript('s16', 'exact.js')
    expect(r.stdout.length).toBe(MAX_OUTPUT - 1)
    expect(r.stdout).not.toContain('输出已截断')
  })

  it('超时被终止：不返回成功且无 exitCode=0', async () => {
    registerSkill('s17', [
      { name: 'slow.js', file: 'slow.js', content: 'setTimeout(() => console.log("late"), 60000)\n' },
    ])
    const started = Date.now()
    const r = await service.executeScript('s17', 'slow.js', [], { timeoutMs: 300 })
    expect(r.success).toBe(false)
    expect(r.exitCode).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(20000)
  })

  it('默认超时为 30s（脚本能正常跑完，不因超时被误杀）', async () => {
    registerSkill('s18', [
      { name: 'quick.js', file: 'quick.js', content: 'console.log("done")\n' },
    ])
    const r = await service.executeScript('s18', 'quick.js')
    expect(r.stdout).toBe('done')
  })

  it('命令不存在（PATH 为空）时走 spawn error 分支且不抛异常', async () => {
    registerSkill('s19', [{ name: 'run.py', file: 'run.py', content: 'print("hi")\n' }])
    const savedPath = process.env.PATH
    process.env.PATH = ''
    try {
      const r = await service.executeScript('s19', 'run.py')
      expect(r.success).toBe(false)
      expect(r.exitCode).toBeNull()
      expect(r.stderr).toContain('[spawn error:')
    } finally {
      process.env.PATH = savedPath
    }
  })
})
