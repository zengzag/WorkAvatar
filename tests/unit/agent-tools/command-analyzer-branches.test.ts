import { describe, it, expect } from 'vitest'
import {
  extractInvokedScriptPaths,
  isFileDeletionCommand,
} from '../../../electron/main/services/agent/tools/command-analyzer'

/** command-analyzer 现在只负责「删除通道策略」与「被执行脚本提取」，写入边界由沙箱强制执行 */

describe('agent/tools/command-analyzer / isFileDeletionCommand', () => {
  it('识别删除原语与脚本内删除逻辑', () => {
    const positives = [
      'rm a.txt',
      'del /q a.txt',
      'erase a.txt',
      'rmdir build',
      'Remove-Item -Recurse build',
      'rd /s /q build',
      'rd /q build',
      "python -c \"import os; os.remove('a')\"",
      "python -c \"import os; os.unlink('a')\"",
      "python -c \"import os; os.rmdir('d')\"",
      "python -c \"import shutil; shutil.rmtree('d')\"",
      "python -c \"from pathlib import Path; Path('a').unlink()\"",
      "python -c \"from pathlib import Path; Path('d').rmdir()\"",
      'node -e "require(\'fs\').promises.rm(\'a\')"',
      'node -e "fs.rmSync(\'d\', { recursive: true })"',
      'node -e "fs.rmdirSync(\'d\')"',
    ]
    for (const cmd of positives) {
      expect(isFileDeletionCommand(cmd), cmd).toBe(true)
    }
  })

  it('不把读取/写入/其它 rm 前缀词误判为删除', () => {
    const negatives = [
      'rmarkdown render report.Rmd',
      'node -e "fs.readFileSync(\'a\')"',
      'echo remove this text > a.txt',
      'python -c "print(1)"',
      'git checkout src/unlink.ts',
    ]
    for (const cmd of negatives) {
      expect(isFileDeletionCommand(cmd), cmd).toBe(false)
    }
  })

  it('包管理器 rm 子命令不误判为删除（仍有真实 rm 时照旧拦截）', () => {
    expect(isFileDeletionCommand('npm rm --save foo')).toBe(false)
    expect(isFileDeletionCommand('yarn rm foo')).toBe(false)
    expect(isFileDeletionCommand('pnpm rm foo')).toBe(false)
    // 但同一条命令里出现真实 rm 仍要拦截
    expect(isFileDeletionCommand('npm rm foo && rm -rf build')).toBe(true)
  })
})

describe('agent/tools/command-analyzer / extractInvokedScriptPaths', () => {
  it('同一解释器段中的多个脚本文件都被提取', () => {
    expect(extractInvokedScriptPaths('python a.py b.py')).toEqual(['a.py', 'b.py'])
  })

  it('.ts/.mjs/.cjs/.sh 等后缀均被识别', () => {
    expect(extractInvokedScriptPaths('node script.ts')).toEqual(['script.ts'])
    expect(extractInvokedScriptPaths('node mod.mjs')).toEqual(['mod.mjs'])
    expect(extractInvokedScriptPaths('bash run.sh')).toEqual(['run.sh'])
    expect(extractInvokedScriptPaths('deno task.ts')).toEqual(['task.ts'])
  })

  it('非解释器开头的命令段不扫描（避免误判普通路径参数）', () => {
    expect(extractInvokedScriptPaths('git diff src/a.py')).toEqual([])
    expect(extractInvokedScriptPaths('tar -czf out.tgz docs/notes.md')).toEqual([])
  })

  it('去重同一脚本重复出现', () => {
    expect(extractInvokedScriptPaths('python a.py; python a.py')).toEqual(['a.py'])
  })

  it('选项后的脚本路径仍被提取，纯选项段不产生路径', () => {
    expect(extractInvokedScriptPaths('node --experimental-vm-modules build.js')).toEqual(['build.js'])
    expect(extractInvokedScriptPaths('node --version')).toEqual([])
  })
})
