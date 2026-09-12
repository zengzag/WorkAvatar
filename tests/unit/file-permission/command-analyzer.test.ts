import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import {
  analyzeCommandPaths,
  extractRelativePathTokens,
  hasUnresolvedDynamicTarget,
  hasRedirection,
  isFileWriteCommand,
  isFileDeletionCommand,
  decideCommandAccess,
  type PathBoundary,
} from '../../../electron/main/services/agent/tools/command-analyzer'
import { normalizePath, isWithinPath } from '../../../electron/main/services/path-normalize'

const IS_WINDOWS = process.platform === 'win32'
const SEP = path.sep

function tempRoot(): string {
  return normalizePath(os.tmpdir())
}

function makeDir(prefix: string): string {
  return normalizePath(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

/** 以真实临时目录构造工作区边界（与 FilePermissionService 的判定一致） */
function makeBoundary(root: string, authorized: string[] = []): PathBoundary {
  const rootNorm = normalizePath(root)
  const authSet = new Set(authorized.map(normalizePath))
  return {
    isInside: p => isWithinPath(normalizePath(p), rootNorm),
    isAuthorized: p => authSet.has(normalizePath(p)),
  }
}

/** 用真实命令分类器跑完整决策（模拟 shell-exec 调用方式） */
function decide(command: string, cwd: string, boundary: PathBoundary) {
  return decideCommandAccess({
    command,
    cwd,
    isDeletion: isFileDeletionCommand(command),
    isWrite: isFileWriteCommand(command),
    boundary,
  })
}

describe('extractRelativePathTokens', () => {
  it('提取含斜杠的相对路径 token', () => {
    const tokens = extractRelativePathTokens('rm -rf build/out ../backup "data/my folder"')
    expect(tokens).toContain('build/out')
    expect(tokens).toContain('../backup')
    expect(tokens).toContain('data/my folder')
  })

  it('排除选项与 URL', () => {
    const tokens = extractRelativePathTokens('npm install --save-dev https://example.com/a.tar.gz -Force')
    expect(tokens.join(' ')).not.toContain('https://')
    expect(tokens.join(' ')).not.toContain('-Force')
    expect(tokens.join(' ')).not.toContain('--save-dev')
  })
})

describe('analyzeCommandPaths - 变量/波浪线路径归类', () => {
  const cwd = tempRoot()

  it('引号包裹的 PowerShell/cmd 变量路径进入 unresolved，不产生区内假路径', () => {
    for (const cmd of [
      'Set-Content "$env:TEMP\\a.txt" -Value x',
      'echo x > "$env:APPDATA\\c.txt"',
      'echo x > "%APPDATA%\\a.txt"',
      'Copy-Item "$HOME/x.txt" dst/',
      'Remove-Item "${TARGET_DIR}\\x" -Recurse',
      'Set-Content "!MYVAR!\\sub\\x.txt" -Value 1',
    ]) {
      const r = analyzeCommandPaths(cmd, cwd)
      expect(r.unresolvedTokens.length, `unresolved: ${cmd}`).toBeGreaterThan(0)
      for (const p of r.resolvedRelativePaths) {
        // 任何解析结果都不允许把变量名当成 cwd 下的字面目录
        expect(p, `fake inside path from ${cmd}`).not.toMatch(/\$env:|%APPDATA%|!MYVAR!|\$\{/)
      }
    }
  })

  it('引号包裹的 ~ 路径展开到家目录而非 cwd', () => {
    const r = analyzeCommandPaths('rm -rf "~/.ssh"', cwd)
    expect(r.unresolvedTokens.length).toBe(0)
    expect(r.resolvedRelativePaths.some(p => isWithinPath(p, normalizePath(os.homedir())))).toBe(true)
    expect(r.resolvedRelativePaths.some(p => isWithinPath(p, cwd))).toBe(false)
  })

  it('普通相对路径仍基于 cwd 解析', () => {
    const r = analyzeCommandPaths('Remove-Item -Recurse build/cache', cwd)
    expect(r.resolvedRelativePaths.length).toBeGreaterThan(0)
    expect(r.resolvedRelativePaths.every(p => p.startsWith(cwd))).toBe(true)
  })

  it('.. 逃逸路径解析到工作区外', () => {
    const r = analyzeCommandPaths('rm ..\\..\\important.txt', cwd)
    expect(r.resolvedRelativePaths.some(p => !p.startsWith(cwd))).toBe(true)
  })

  it('绝对路径原样返回', () => {
    const abs = IS_WINDOWS ? 'D:\\data\\out.csv' : '/var/data/out.csv'
    const { absolutePaths } = analyzeCommandPaths(`Copy-Item a.txt "${abs}"`, cwd)
    expect(absolutePaths).toContain(abs)
  })
})

describe('hasUnresolvedDynamicTarget - 裸变量/波浪线检测', () => {
  const positive = [
    'echo x > $HOME/x.txt',
    'Remove-Item $env:TEMP\\x -Recurse',
    'cp a.log ${LOG_DIR}/b.log',
    'echo x > %APPDATA%\\a.txt',
    'echo x > !LOG!\\a.txt',
    'rm -rf ~/.ssh',
    'rm -rf ~',
    'Set-Location $env:TEMP; Remove-Item a.txt',
    'cd ~/work; rm a.txt',
    'pushd "%APP_DIR%"; del c.log',
  ]
  for (const cmd of positive) {
    it(`命中: ${cmd}`, () => {
      expect(hasUnresolvedDynamicTarget(cmd)).toBe(true)
    })
  }

  const negative = [
    'echo "$date" > log.txt',           // 变量在内容中且无路径分隔符
    'echo exit=$? >> run.log',          // $? 不是路径
    'Set-Content note.txt -Value "$x"', // 引号内容无分隔符
    'cp build/out.txt dist/out.txt',    // 普通相对路径
    'npm install --save-dev',
  ]
  for (const cmd of negative) {
    it(`不命中（防误报）: ${cmd}`, () => {
      expect(hasUnresolvedDynamicTarget(cmd)).toBe(false)
    })
  }
})

describe('hasRedirection - 重定向写入检测', () => {
  it('识别常规重定向', () => {
    expect(hasRedirection('echo x > out.txt')).toBe(true)
    expect(hasRedirection('ls >> log.txt')).toBe(true)
    expect(hasRedirection('echo x > ./out.txt')).toBe(true)
    expect(hasRedirection('echo x > "../backup/a.txt"')).toBe(true)
  })

  it('识别变量/波浪线/环境变量目标（历史漏报）', () => {
    expect(hasRedirection('echo x > $HOME/x.txt')).toBe(true)
    expect(hasRedirection('echo x > ~/out.txt')).toBe(true)
    expect(hasRedirection('echo x > %APPDATA%\\a.txt')).toBe(true)
    expect(hasRedirection('echo x > "$HOME/x.txt"')).toBe(true)
  })

  it('排除句柄重定向 2>&1', () => {
    expect(hasRedirection('cmd 2>&1')).toBe(false)
  })
})

describe('decideCommandAccess - 智能体典型脚本决策矩阵', () => {
  let ws: string
  let other: string

  beforeEach(() => {
    ws = makeDir('wa-dc-ws-')
    other = makeDir('wa-dc-out-')
  })
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true })
    fs.rmSync(other, { recursive: true, force: true })
  })

  it('区内字面路径写入/删除 → allow', () => {
    const b = makeBoundary(ws)
    expect(decide('Set-Content sub/a.txt -Value 1', ws, b).kind).toBe('allow')
    expect(decide('Remove-Item -Recurse build/cache', ws, b).kind).toBe('allow')
    expect(decide('echo x > log.txt', ws, b).kind).toBe('allow')
  })

  it('区外绝对路径 → authorize-paths 且聚合全部区外路径', () => {
    const b = makeBoundary(ws)
    const outsideAbs = path.join(other, 'x.txt')
    const d = decide(`Copy-Item a.txt "${outsideAbs}"`, ws, b)
    expect(d.kind).toBe('authorize-paths')
    if (d.kind === 'authorize-paths') {
      expect(d.operation).toBe('修改')
      expect(d.paths.some(p => normalizePath(p) === normalizePath(outsideAbs))).toBe(true)
    }
  })

  it('相对路径 .. 逃逸工作区 → authorize-paths', () => {
    const b = makeBoundary(ws)
    const d = decide('rm -rf ../../../secret', ws, b)
    expect(d.kind).toBe('authorize-paths')
  })

  it('变量引用的写入命令（历史漏报：仅删除有兜底）→ confirm-command', () => {
    const b = makeBoundary(ws)
    expect(decide('Set-Content "$env:TEMP\\a.txt" -Value x', ws, b).kind).toBe('confirm-command')
    expect(decide('echo x > $HOME/x.txt', ws, b).kind).toBe('confirm-command')
    expect(decide('echo x > %APPDATA%\\a.txt', ws, b).kind).toBe('confirm-command')
  })

  it('rm -rf ~/.ssh 无引号（历史完全漏检）→ confirm-command', () => {
    const b = makeBoundary(ws)
    const d = decide('rm -rf ~/.ssh', ws, b)
    expect(d.kind).toBe('confirm-command')
    if (d.kind === 'confirm-command') expect(d.operation).toBe('删除')
  })

  it('cd 到变量目录后操作裸词 → confirm-command', () => {
    const b = makeBoundary(ws)
    expect(decide('Set-Location $env:TEMP; Remove-Item a.txt', ws, b).kind).toBe('confirm-command')
    expect(decide('cd $APP_DIR; echo x > a.log', ws, b).kind).toBe('confirm-command')
  })

  it('工作区内无具体目标的删除（glob/裸词）→ confirm-command', () => {
    const b = makeBoundary(ws)
    expect(decide('rm -rf *', ws, b).kind).toBe('confirm-command')
    expect(decide('del *.tmp', ws, b).kind).toBe('confirm-command')
  })

  it('cwd 在区外 + 无具体目标 → authorize-dir 且授权目录就是 cwd 本身', () => {
    const b = makeBoundary(ws)
    const d = decide('echo x > a.txt', other, b)
    expect(d.kind).toBe('authorize-dir')
    if (d.kind === 'authorize-dir') {
      expect(normalizePath(d.dir)).toBe(other)
    }
  })

  it('已授权的区外路径 → allow', () => {
    const target = path.join(other, 'ok.txt')
    const b = makeBoundary(ws, [target])
    expect(decide(`cp a.txt "${target}"`, ws, b).kind).toBe('allow')
  })

  it('非写/删命令（ls/git/npm）→ allow 不做路径干预', () => {
    const b = makeBoundary(ws)
    expect(decide('git status', ws, b).kind).toBe('allow')
    expect(decide('ls -la /etc', ws, b).kind).toBe('allow')
  })

  it('变量仅在写入内容中（无路径分隔符）不误报 → allow', () => {
    const b = makeBoundary(ws)
    expect(decide('echo "$date done" > log.txt', ws, b).kind).toBe('allow')
  })

  it('多命令脚本：区内命令 + 区外字面路径 → authorize-paths', () => {
    const b = makeBoundary(ws)
    const outsideAbs = path.join(other, 'dump.txt')
    const d = decide(`echo start; Set-Content "${outsideAbs}" -Value x; echo done`, ws, b)
    expect(d.kind).toBe('authorize-paths')
  })

  it('Python heredoc 写区外字面路径 → authorize-paths（脚本原语识别）', () => {
    const b = makeBoundary(ws)
    const outsideAbs = path.join(other, 'data.json')
    const script = `python - <<'PY'\nwith open(r"${outsideAbs}", "w") as f:\n    f.write("x")\nPY\n`
    const d = decide(script, ws, b)
    expect(d.kind).toBe('authorize-paths')
    if (d.kind === 'authorize-paths') {
      expect(d.paths.some(p => normalizePath(p) === normalizePath(outsideAbs))).toBe(true)
    }
  })

  it('Python heredoc 写区内相对路径 → allow', () => {
    const b = makeBoundary(ws)
    const script = `python - <<'PY'\nwith open("out/data.json", "w") as f:\n    f.write("x")\nPY\n`
    expect(decide(script, ws, b).kind).toBe('allow')
  })

  it('Node.js stdin 脚本 fs.writeFileSync 区外路径 → authorize-paths', () => {
    const b = makeBoundary(ws)
    const outsideAbs = path.join(other, 'a.txt')
    const script = `node -\nfs.writeFileSync(${JSON.stringify(outsideAbs)}, "x")`
    const d = decide(script, ws, b)
    expect(d.kind).toBe('authorize-paths')
  })

  it('Python os.remove 区外字面路径 → 删除决策', () => {
    const b = makeBoundary(ws)
    const outsideAbs = path.join(other, 'gone.txt')
    const d = decide(`python -c "import os; os.remove(r'${outsideAbs}')"`, ws, b)
    expect(d.kind).toBe('authorize-paths')
    if (d.kind === 'authorize-paths') expect(d.operation).toBe('删除')
  })

  it('纯读取脚本（open 默认 r 模式）不触发写/删分类 → allow', () => {
    const b = makeBoundary(ws)
    const script = `python - <<'PY'\nwith open("data/in.json") as f:\n    print(f.read())\nPY\n`
    expect(decide(script, ws, b).kind).toBe('allow')
  })
})

describe('decideCommandAccess - 决策优先级与操作类型', () => {
  it('删除操作 operation 为删除，写入为修改', () => {
    const ws = makeDir('wa-dc-op-')
    const b = makeBoundary(ws)
    const outsideAbs = path.join(path.dirname(ws), `wa-dc-op-out-${Date.now()}`, 'x')
    const del = decide(`rm "${outsideAbs}"`, ws, b)
    expect(del.kind).toBe('authorize-paths')
    if (del.kind === 'authorize-paths') expect(del.operation).toBe('删除')
    const write = decide(`cp a "${outsideAbs}2"`, ws, b)
    if (write.kind === 'authorize-paths') expect(write.operation).toBe('修改')
  })

  it('SEP 健全性', () => {
    expect(SEP).toBe(path.sep)
  })
})
