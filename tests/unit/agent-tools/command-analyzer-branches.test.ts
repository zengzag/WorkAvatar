import { describe, it, expect } from 'vitest'
import * as os from 'os'
import * as path from 'path'
import {
  analyzeCommandPaths,
  extractAbsolutePaths,
  extractInvokedScriptPaths,
  extractRelativePathTokens,
  hasRedirection,
  hasUnresolvedDynamicTarget,
  isFileDeletionCommand,
  isFileWriteCommand,
} from '../../../electron/main/services/agent/tools/command-analyzer'
import { normalizePath, isWithinPath } from '../../../electron/main/services/path-normalize'

const IS_WINDOWS = process.platform === 'win32'

/** 补充 command-analyzer 未覆盖分支（决策矩阵见 file-permission/command-analyzer.test.ts） */

describe('agent/tools/command-analyzer / isFileWriteCommand', () => {
  it('识别各类写入原语（PowerShell / POSIX / Python / Node）', () => {
    const positives = [
      'Set-Content out.txt -Value x',
      'Add-Content out.txt -Value x',
      'Out-File out.txt',
      'New-Item -ItemType File out.txt',
      'Copy-Item a.txt b.txt',
      'Move-Item a.txt b.txt',
      'xcopy src dst',
      'robocopy src dst',
      'mkdir build',
      'touch new.txt',
      'tee output.log',
      'cp a b',
      'mv a b',
      "python -c \"open('a.txt','w')\"",
      "python -c \"open('a.txt','a')\"",
      'python -c "import os; os.makedirs(\"d\")"',
      "python -c \"import shutil; shutil.copy('a','b')\"",
      "python -c \"from pathlib import Path; Path('a').write_text('x')\"",
      'node -e "fs.promises.appendFile(\'a\',\'x\')"',
      'node -e "fs.mkdirSync(\'d\')"',
      'node -e "fs.renameSync(\'a\',\'b\')"',
      'node -e "fs.createWriteStream(\'a\')"',
      'echo hi > out.txt',
      'echo hi >> out.txt',
    ]
    for (const cmd of positives) {
      expect(isFileWriteCommand(cmd), cmd).toBe(true)
    }
  })

  it('require("fs").writeFileSync / promises.writeFile 形式同样识别为写入', () => {
    const target = IS_WINDOWS ? 'C:\\Windows\\Temp\\wa-probe.txt' : '/tmp/wa-probe.txt'
    expect(isFileWriteCommand(`node -e "require('fs').writeFileSync('${target}','x')"`)).toBe(true)
    expect(isFileWriteCommand(`node -e "require('fs').promises.writeFile('${target}','x')"`)).toBe(true)
  })

  it('纯读取/执行/查询类命令不误判为写入', () => {
    const negatives = [
      'git status',
      'npm test',
      'ls -la',
      'cat a.txt',
      "python -c \"open('data.txt')\"",
      "python -c \"print(open('a.txt').read())\"",
      'node build.js',
      'grep -n foo a.txt',
      'Remove-Item a.txt', // 删除类走另一分支（此处仅断言不误判为写入）
    ]
    for (const cmd of negatives) {
      expect(isFileWriteCommand(cmd), cmd).toBe(false)
    }
  })

  it('重定向判定：仅在目标看起来像路径时命中', () => {
    expect(hasRedirection('echo x > out.txt')).toBe(true)
    expect(hasRedirection('echo x > "quoted.txt"')).toBe(true)
    expect(hasRedirection('(echo x > out.txt)')).toBe(true)
    expect(hasRedirection('echo 2>&1')).toBe(false)
    expect(hasRedirection('echo x >&2')).toBe(false)
    expect(hasRedirection('a >= b')).toBe(false)
  })

  it('紧贴式重定向（前一个字符非空白）同样识别为写入', () => {
    expect(hasRedirection('echo x>out.txt')).toBe(true)
    const outsideTarget = IS_WINDOWS ? 'C:\\Windows\\Temp\\wa-probe.txt' : '/tmp/wa-probe.txt'
    const writeCmd = `echo x>${outsideTarget}`
    expect(isFileWriteCommand(writeCmd)).toBe(true)
  })
})

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

describe('agent/tools/command-analyzer / extractAbsolutePaths', () => {
  it('带引号的 Windows 路径（含空格）被完整提取并去重', () => {
    const text = 'Copy-Item "D:\\my docs\\a.txt" "D:\\my docs\\a.txt"'
    const paths = extractAbsolutePaths(text)
    expect(paths).toContain('D:\\my docs\\a.txt')
    expect(paths.filter(p => p === 'D:\\my docs\\a.txt')).toHaveLength(1)
  })

  it('引号路径不再被无引号正则重复提取为被空格截断的脏路径', () => {
    const paths = extractAbsolutePaths('Copy-Item "D:\\my docs\\a.txt"')
    expect(paths).toEqual(['D:\\my docs\\a.txt'])
  })

  it('无引号路径不会吞掉闭合引号', () => {
    const paths = extractAbsolutePaths('Set-Content C:\\tmp\\out.txt -Value x')
    expect(paths).toContain('C:\\tmp\\out.txt')
    expect(paths.some(p => p.endsWith('"'))).toBe(false)
  })

  it('无引号 POSIX 路径受 \\b 边界限制：前导为空白时不识别（依赖 token 扫描兜底）', () => {
    // `\b` 要求前一字符是单词字符，因此 "cp a.txt /home/u/b.txt" 这类常规写法不会命中
    expect(extractAbsolutePaths('cp a.txt /home/u/b.txt')).not.toContain('/home/u/b.txt')
    // 紧贴单词字符时才命中
    expect(extractAbsolutePaths('x/home/u/b.txt')).toContain('/home/u/b.txt')
  })

  it('忽略管道/分号等分隔符后的非路径内容', () => {
    expect(extractAbsolutePaths('echo a | /usr/bin/sort')).toEqual([])
  })
})

describe('agent/tools/command-analyzer / 路径 token 扫描', () => {
  it('排除 URL 与 -/-- 选项', () => {
    const tokens = extractRelativePathTokens('curl https://example.com/a/b.zip -o out/a.zip --config=cfg/a.ini')
    expect(tokens.join(' ')).not.toContain('https://')
    expect(tokens).not.toContain('--config=cfg/a.ini')
    // -o 的值是普通文件路径，依然作为 token 出现
    expect(tokens).toContain('out/a.zip')
  })

  it('超过 500 字符的 token 被丢弃（防超长路径拖慢分析）', () => {
    const long = `${'a/'.repeat(300)}b.txt`
    expect(long.length).toBeGreaterThan(500)
    expect(extractRelativePathTokens(`cp a.txt ${long}`)).toEqual([])
  })

  it('~ 前缀展开为家目录，且不再落在 cwd 下', () => {
    const r = analyzeCommandPaths('cp x.txt "~/backup/x.txt"', os.tmpdir())
    expect(r.unresolvedTokens).toEqual([])
    const home = normalizePath(os.homedir())
    expect(r.resolvedRelativePaths.some(p => isWithinPath(p, home))).toBe(true)
    expect(r.resolvedRelativePaths.some(p => isWithinPath(p, normalizePath(os.tmpdir())))).toBe(false)
  })

  it('变量 token 不 resolve，避免造出 cwd 下的假路径', () => {
    const r = analyzeCommandPaths('cp a.txt "$env:TEMP/x.txt"', os.tmpdir())
    expect(r.unresolvedTokens).toContain('$env:TEMP/x.txt')
    expect(r.resolvedRelativePaths.every(p => !p.includes('TEMP/x.txt'))).toBe(true)
  })

  it('绝对路径与相对路径分别归类', () => {
    const cwd = os.tmpdir()
    const abs = IS_WINDOWS ? 'C:\\abs\\a.txt' : '/tmp/abs/a.txt'
    const cmd = IS_WINDOWS ? `Copy-Item ${abs} sub/b.txt` : `cp ${abs} sub/b.txt`
    const r = analyzeCommandPaths(cmd, cwd)
    expect(r.absolutePaths).toContain(abs)
    expect(r.resolvedRelativePaths).toContain(normalizePath(path.resolve(cwd, 'sub/b.txt')))
  })

  it('hasUnresolvedDynamicTarget：cd 到变量/家目录后命中，普通 cd 不命中', () => {
    expect(hasUnresolvedDynamicTarget('cd $env:TEMP; echo x > a.txt')).toBe(true)
    expect(hasUnresolvedDynamicTarget('cd ~/work; echo x > a.txt')).toBe(true)
    expect(hasUnresolvedDynamicTarget('cd build; echo x > a.txt')).toBe(false)
    expect(hasUnresolvedDynamicTarget('Set-Location sub; echo x > a.txt')).toBe(false)
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
