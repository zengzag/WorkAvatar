/**
 * 数据目录服务单测（electron 经 Module._load 拦截打桩，配置目录指向临时目录）：
 * - 默认目录推导（documents/WorkAvatar）与自动建目录
 * - 配置读写：自定义目录持久化、损坏配置回落默认
 * - DB / KMS DB / 向量库 / skills 子路径拼接
 * - setDataDir 的目录创建与可写性校验分支
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Module from 'module'

const mockState = vi.hoisted(() => ({
  userDataDir: '',
  documentsDir: '',
  packaged: true,
}))

const origModuleLoad = (Module as any)._load

function installElectronStub(): void {
  ;(Module as any)._load = function (this: any, request: string, parent: any, isMain: boolean) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: mockState.packaged,
          getPath: (name: string) =>
            name === 'documents' ? mockState.documentsDir : mockState.userDataDir,
        },
      }
    }
    return origModuleLoad.call(this, request, parent, isMain)
  }
}

function restoreModuleLoad(): void {
  ;(Module as any)._load = origModuleLoad
}

type PathServiceInstance = ReturnType<
  typeof import('../../../electron/main/services/path.service').default.getInstance
>

async function freshService(): Promise<PathServiceInstance> {
  vi.resetModules()
  const mod = await import('../../../electron/main/services/path.service')
  return mod.default.getInstance()
}

let root = ''
let dataDirOverride = ''

beforeEach(() => {
  vi.resetModules()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-path-test-'))
  mockState.userDataDir = path.join(root, 'user-data')
  mockState.documentsDir = path.join(root, 'documents')
  mockState.packaged = true
  dataDirOverride = ''
  installElectronStub()
})

afterEach(() => {
  restoreModuleLoad()
  fs.rmSync(root, { recursive: true, force: true })
})

/** 预写配置文件（模拟上次运行保存的自定义数据目录） */
function writeConfigFile(dataDir: string): void {
  fs.mkdirSync(mockState.userDataDir, { recursive: true })
  fs.writeFileSync(
    path.join(mockState.userDataDir, 'workavatar-path.json'),
    JSON.stringify({ dataDir }),
    'utf-8',
  )
}

describe('path.service / 默认目录与配置读取', () => {
  it('无配置时使用 documents/WorkAvatar 并自动创建', async () => {
    const svc = await freshService()
    const expected = path.join(mockState.documentsDir, 'WorkAvatar')
    expect(svc.getDataDir()).toBe(expected)
    expect(fs.existsSync(expected)).toBe(true)
    expect(svc.getIsDev()).toBe(false)
  })

  it('读取已保存的自定义目录', async () => {
    const custom = path.join(root, 'custom-data')
    writeConfigFile(custom)
    const svc = await freshService()
    expect(svc.getDataDir()).toBe(custom)
    expect(fs.existsSync(custom)).toBe(true)
  })

  it('配置文件损坏时回落默认目录且不抛错', async () => {
    fs.mkdirSync(mockState.userDataDir, { recursive: true })
    fs.writeFileSync(path.join(mockState.userDataDir, 'workavatar-path.json'), '{ not json', 'utf-8')
    const svc = await freshService()
    expect(svc.getDataDir()).toBe(path.join(mockState.documentsDir, 'WorkAvatar'))
  })

  it('配置缺少 dataDir 字段时回落默认目录', async () => {
    fs.mkdirSync(mockState.userDataDir, { recursive: true })
    fs.writeFileSync(path.join(mockState.userDataDir, 'workavatar-path.json'), '{}', 'utf-8')
    const svc = await freshService()
    expect(svc.getDataDir()).toBe(path.join(mockState.documentsDir, 'WorkAvatar'))
  })
})

describe('path.service / 子路径拼接', () => {
  it('DB / KMS DB / 向量库路径均基于数据目录', async () => {
    const custom = path.join(root, 'd')
    writeConfigFile(custom)
    const svc = await freshService()
    expect(svc.getDbPath()).toBe(path.join(custom, 'workavatar.db'))
    expect(svc.getKMSDbPath()).toBe(path.join(custom, 'workavatar-kms.db'))
    expect(svc.getKMSVectorDbPath()).toBe(path.join(custom, 'workavatar-kms-vectors.db'))
  })

  it('getSkillsDir 自动创建 skills 目录', async () => {
    const custom = path.join(root, 'd2')
    writeConfigFile(custom)
    const svc = await freshService()
    const dir = svc.getSkillsDir()
    expect(dir).toBe(path.join(custom, 'skills'))
    expect(fs.existsSync(dir)).toBe(true)
  })

  it('打包模式下资源目录位于 process.resourcesPath 下', async () => {
    const resourcesPath = path.join(root, 'resources-root')
    Object.defineProperty(process, 'resourcesPath', { value: resourcesPath, configurable: true })
    const svc = await freshService()
    expect(svc.getResourcesDir()).toBe(path.join(resourcesPath, 'resources'))
    delete (process as any).resourcesPath
  })
})

describe('path.service / setDataDir', () => {
  it('新目录不存在时自动创建并持久化', async () => {
    const svc = await freshService()
    const target = path.join(root, 'new-data')
    expect(svc.setDataDir(target)).toEqual({ success: true })
    expect(svc.getDataDir()).toBe(target)
    expect(fs.existsSync(target)).toBe(true)

    const saved = JSON.parse(
      fs.readFileSync(path.join(mockState.userDataDir, 'workavatar-path.json'), 'utf-8'),
    )
    expect(saved.dataDir).toBe(target)
  })

  it('持久化后的目录被下次启动读取', async () => {
    const svc = await freshService()
    const target = path.join(root, 'persist-data')
    svc.setDataDir(target)
    const next = await freshService()
    expect(next.getDataDir()).toBe(target)
  })

  it('写入测试文件后立即删除（不留残余）', async () => {
    const svc = await freshService()
    const target = path.join(root, 'clean-data')
    svc.setDataDir(target)
    expect(fs.readdirSync(target)).toEqual([])
  })

  it('目标路径被文件占用时返回"目录不可写"', async () => {
    const svc = await freshService()
    const filePath = path.join(root, 'a-file')
    fs.writeFileSync(filePath, 'x')
    expect(svc.setDataDir(filePath)).toEqual({ success: false, error: '目录不可写' })
    // 失败时不改变当前数据目录
    expect(svc.getDataDir()).toBe(path.join(mockState.documentsDir, 'WorkAvatar'))
  })

  it('父路径是文件导致无法创建目录时返回"无法创建目录"', async () => {
    const svc = await freshService()
    const filePath = path.join(root, 'blocker')
    fs.writeFileSync(filePath, 'x')
    expect(svc.setDataDir(path.join(filePath, 'sub'))).toEqual({ success: false, error: '无法创建目录' })
  })

  it('重复设置为同一目录幂等', async () => {
    const svc = await freshService()
    const target = path.join(root, 'same-data')
    expect(svc.setDataDir(target).success).toBe(true)
    expect(svc.setDataDir(target).success).toBe(true)
    expect(svc.getDataDir()).toBe(target)
  })
})
