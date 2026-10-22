import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { runCommandPlatform } from '../../../electron/main/services/agent/tools/exec-shared'
import { windowsRunnerPath } from '../../../electron/main/services/sandbox.service'

// 真机集成检查：真实调用 OS 沙箱运行器（不 mock），需先执行 npm run gen:sandbox
const enabled = process.platform === 'win32' && fs.existsSync(windowsRunnerPath())

describe.skipIf(!enabled)('sandbox 真机集成', () => {
  let base: string
  let ws: string
  let outside: string
  let script: string

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-it-'))
    ws = path.join(base, 'ws')
    outside = path.join(base, 'outside')
    fs.mkdirSync(ws)
    fs.mkdirSync(outside)
    script = path.join(base, 'writer.js')
    fs.writeFileSync(script, [
      "const fs = require('fs')",
      'const [inside, out] = process.argv.slice(2)',
      "fs.writeFileSync(inside, 'x')",
      "console.log('INSIDE=OK')",
      // 区外写入不捕获：让运行时把 EPERM/EACCES 打到 stderr（真实失败路径）
      "fs.writeFileSync(out, 'x')",
      "console.log('OUTSIDE=OK')",
    ].join('\n'))
  })

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('工作区内可写、区外被内核拒绝并标记 denied', async () => {
    const res = await runCommandPlatform(`node "${script}" "${path.join(ws, 'a.txt')}" "${path.join(outside, 'b.txt')}"`, {
      cwd: ws,
      timeoutMs: 30000,
      workspaceRoot: ws,
    })
    expect(res.sandboxError).toBeUndefined()
    expect(res.sandboxRunnerFailed).toBeFalsy()
    expect(res.stdout).toContain('INSIDE=OK')
    expect(res.stdout).not.toContain('OUTSIDE=OK')
    expect(fs.existsSync(path.join(ws, 'a.txt'))).toBe(true)
    expect(fs.existsSync(path.join(outside, 'b.txt'))).toBe(false)
    expect(res.code).not.toBe(0)
    expect(res.sandbox?.backend).toBe('windows-acl')
    expect(res.sandbox?.denied).toBe(true)
  }, 60000)

  it('working_dir 被透传，不被改写成工作区', async () => {
    const res = await runCommandPlatform('node -e "console.log(process.cwd())"', {
      cwd: outside,
      timeoutMs: 30000,
      workspaceRoot: ws,
    })
    expect(res.sandboxError).toBeUndefined()
    expect(fs.realpathSync(res.stdout.trim())).toBe(fs.realpathSync(outside))
  }, 60000)
})
