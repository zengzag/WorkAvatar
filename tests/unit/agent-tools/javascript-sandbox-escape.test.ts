import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { javascriptExecTool } from '../../../electron/main/services/agent/tools/javascript-exec.tool'

/**
 * javascript_exec 沙箱安全边界测试。
 * 修复前：这些 PoC 会证明逃逸可行（断言失败即逃逸存在）；
 * 修复后：全部转绿，锁定安全行为。
 */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sandbox-'))
}

async function run(code: string, workingDir: string) {
  return javascriptExecTool.handler({ code, working_dir: workingDir, timeout: 10 }) as any
}

describe('javascript_exec 沙箱边界', () => {
  it('宿主对象不可经 constructor.constructor 逃逸获取宿主 process', async () => {
    const dir = makeTempDir()
    try {
      const res = await run(`
        const hostProcess = Promise.constructor.constructor('return process')();
        console.log('HOST_ON=' + typeof hostProcess.on);
        console.log('HOST_PID=' + typeof hostProcess.pid);
      `, dir)
      const output = String(res.output || '')
      // typeof hostProcess.on 必须不是宿主的 'function'（沙箱 fake process 无 on）
      expect(output).not.toContain('HOST_ON=function')
      expect(output).not.toContain('HOST_PID=number')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('不可经宿主 Function 动态 import 拿到 child_process', async () => {
    const dir = makeTempDir()
    try {
      const res = await run(`
        const mod = await Promise.constructor.constructor("return import('node:child_process')")();
        console.log('CP=' + typeof mod.execSync);
      `, dir)
      const output = String(res.output || '')
      expect(output).not.toContain('CP=function')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fs 低层写原语（openSync/writeSync）应被封禁', async () => {
    const dir = makeTempDir()
    try {
      const res = await run(`
        const nfs = require('fs');
        const fd = nfs.openSync('bypass.txt', 'w');
        nfs.writeSync(fd, 'pwned');
        nfs.closeSync(fd);
        console.log('WROTE=' + nfs.existsSync('bypass.txt'));
      `, dir)
      const output = String(res.output || '')
      expect(output).not.toContain('WROTE=true')
      expect(fs.existsSync(path.join(dir, 'bypass.txt'))).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('常规读操作不受影响（fs.readFileSync 可用）', async () => {
    const dir = makeTempDir()
    try {
      fs.writeFileSync(path.join(dir, 'ok.txt'), 'hello', 'utf-8')
      const res = await run(`
        const nfs = require('fs');
        console.log('CONTENT=' + nfs.readFileSync(${JSON.stringify(path.join(dir, 'ok.txt'))}, 'utf-8'));
      `, dir)
      expect(res.success, `error: ${res.error}`).toBe(true)
      expect(String(res.output)).toContain('CONTENT=hello')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('宿主类（TextEncoder）不注入：无 V8 intrinsic 之外的隐式全局逃逸面', async () => {
    const dir = makeTempDir()
    try {
      const res = await run(`
        console.log('TE=' + (typeof TextEncoder));
        console.log('TD=' + (typeof TextDecoder));
      `, dir)
      // TextEncoder/TextDecoder 是宿主类，其实例 constructor 链可达宿主 Function
      // （codeGeneration:false 只禁沙箱内编译），故不注入；编码用 Buffer 替代
      expect(String(res.output)).toContain('TE=undefined')
      expect(String(res.output)).toContain('TD=undefined')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
