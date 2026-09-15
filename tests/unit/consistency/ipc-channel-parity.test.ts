import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { IPC_CHANNELS } from '../../../electron/shared/channels'

/**
 * IPC 通道三方一致性契约：
 * 1) electron/shared/channels/*.ts 的通道常量（单源真相）
 * 2) electron/main/** 中 safeHandle / ipcMain.handle / ipcMain.on 注册与推送
 * 3) electron/preload/index.ts 暴露给渲染端的 invoke / send / on API
 *
 * 采用静态文本扫描，避免拉起 Electron 运行时。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const MAIN_DIR = path.join(ROOT, 'electron', 'main')
const PRELOAD_FILE = path.join(ROOT, 'electron', 'preload', 'index.ts')
const SHARED_HANDLE_HELPER = path.join(MAIN_DIR, 'ipc', '_shared.ts')

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkTs(full, out)
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

function matchAll(text: string, re: RegExp): string[] {
  return [...text.matchAll(re)].map((m) => m[1])
}

const mainFiles = walkTs(MAIN_DIR)
const mainSources = mainFiles.map((file) => ({ file, text: fs.readFileSync(file, 'utf-8') }))
const preloadText = fs.readFileSync(PRELOAD_FILE, 'utf-8')

/** 主进程注册了 handler（ipcRenderer.invoke 的对端） */
const handled = new Map<string, string>()
/** 主进程注册了 ipcMain.on 监听（ipcRenderer.send 的对端） */
const listened = new Map<string, string>()
/** 主进程向渲染端推送（webContents.send / sender.send） */
const pushed = new Map<string, string>()

for (const { file, text } of mainSources) {
  for (const name of matchAll(text, /(?:safeHandle|ipcMain\.handle)\(\s*IPC_CHANNELS\.([A-Z0-9_]+)/g)) {
    handled.set(name, file)
  }
  for (const name of matchAll(text, /ipcMain\.on\(\s*IPC_CHANNELS\.([A-Z0-9_]+)/g)) listened.set(name, file)
  for (const name of matchAll(text, /\.send\(\s*IPC_CHANNELS\.([A-Z0-9_]+)/g)) pushed.set(name, file)
}

const preloadInvoke = new Set(matchAll(preloadText, /ipcRenderer\.invoke\(\s*IPC_CHANNELS\.([A-Z0-9_]+)/g))
const preloadSend = new Set(matchAll(preloadText, /ipcRenderer\.send\(\s*IPC_CHANNELS\.([A-Z0-9_]+)/g))
const preloadOn = new Set(matchAll(preloadText, /ipcRenderer\.on\(\s*IPC_CHANNELS\.([A-Z0-9_]+)/g))

const constantNames = new Set<string>()
const channelValueToName = new Map<string, string[]>()
for (const [name, value] of Object.entries(IPC_CHANNELS as Record<string, string>)) {
  if (!channelValueToName.has(value)) channelValueToName.set(value, [])
  channelValueToName.get(value)!.push(name)
  constantNames.add(name)
}

const diff = (a: Iterable<string>, b: Iterable<string>): string[] => {
  const bSet = new Set(b)
  return [...a].filter((x) => !bSet.has(x)).sort()
}

describe('IPC 通道常量定义', () => {
  it('常量值非空且无重复（不同常量不得映射到同一通道）', () => {
    const violations: string[] = []
    for (const [value, names] of channelValueToName.entries()) {
      if (!value.trim()) violations.push(`存在空通道值: ${names.join(', ')}`)
      if (names.length > 1) violations.push(`通道值 "${value}" 被多个常量复用: ${names.join(', ')}`)
    }
    expect(violations, violations.join('\n')).toEqual([])
  })
})

describe('主进程注册 ↔ 通道常量', () => {
  it('handler / ipcMain.on / 推送引用的常量名都存在于通道常量定义', () => {
    const used = [...handled.keys(), ...listened.keys(), ...pushed.keys()]
    const unknown = diff(used, constantNames)
    expect(unknown, `以下通道常量名未在 channels/*.ts 中定义: ${unknown.join(', ')}`).toEqual([])
  })

  it('除 _shared.ts（safeHandle 实现）外，不得绕过常量直接注册裸字符串通道', () => {
    const violations: string[] = []
    for (const { file, text } of mainSources) {
      if (file === SHARED_HANDLE_HELPER) continue
      const raw = matchAll(text, /(?:safeHandle|ipcMain\.handle|ipcMain\.on)\(\s*(?!IPC_CHANNELS\.)([A-Za-z_$][A-Za-z0-9_$.]*)/g)
      for (const arg of raw) violations.push(`${path.relative(ROOT, file)}: 首个参数为 ${arg}（应为 IPC_CHANNELS 常量）`)
    }
    expect(violations, violations.join('\n')).toEqual([])
  })
})

describe('preload API ↔ 主进程注册', () => {
  it('preload 至少暴露一个 invoke/send/on 通道（防止解析失效导致断言空转）', () => {
    expect(preloadInvoke.size).toBeGreaterThan(0)
    expect(preloadSend.size).toBeGreaterThan(0)
    expect(preloadOn.size).toBeGreaterThan(0)
  })

  it('每个 ipcRenderer.invoke 通道都有主进程 handler', () => {
    const missing = diff(preloadInvoke, handled.keys())
    expect(missing, `preload invoke 但主进程未注册 handler: ${missing.join(', ')}`).toEqual([])
  })

  it('每个 ipcRenderer.send 通道都有 ipcMain.on 监听', () => {
    const missing = diff(preloadSend, listened.keys())
    expect(missing, `preload send 但主进程未监听: ${missing.join(', ')}`).toEqual([])
  })

  it('每个 ipcRenderer.on 通道都有主进程发送方（推送或同通道监听）', () => {
    const senders = new Set([...pushed.keys(), ...listened.keys()])
    const missing = diff(preloadOn, senders)
    expect(missing, `preload 订阅但主进程无发送方: ${missing.join(', ')}`).toEqual([])
  })
})

describe('通道常量 ↔ 主进程使用', () => {
  it('不存在定义了但主进程完全未使用的僵尸通道', () => {
    const used = new Set([...handled.keys(), ...listened.keys(), ...pushed.keys()])
    const orphan = diff(constantNames, used).map((name) => `${name} = ${(IPC_CHANNELS as Record<string, string>)[name]}`)
    expect(orphan, `已定义但主进程无任何 handler/listener/push 的通道:\n${orphan.join('\n')}`).toEqual([])
  })
})
