import path from 'path'
import fs from 'fs'
import { app } from 'electron'

const CONFIG_FILENAME = 'workavatar-path.json'

class PathService {
  private dataDir: string
  private static instance: PathService

  private constructor() {
    this.dataDir = this.readConfig() || this.getDefaultDir()
    this.ensureDir(this.dataDir)
  }

  static getInstance(): PathService {
    if (!PathService.instance) {
      PathService.instance = new PathService()
    }
    return PathService.instance
  }

  private getDefaultDir(): string {
    return path.join(app.getPath('documents'), 'WorkAvatar')
  }

  private getConfigPath(): string {
    const isDev = !app.isPackaged
    const configDir = isDev
      ? path.join(process.cwd(), '.workavatar-data')
      : app.getPath('userData')
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true })
    }
    return path.join(configDir, CONFIG_FILENAME)
  }

  private readConfig(): string | null {
    try {
      const configPath = this.getConfigPath()
      if (fs.existsSync(configPath)) {
        const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
        return data.dataDir || null
      }
    } catch {}
    return null
  }

  private writeConfig(): void {
    try {
      const configPath = this.getConfigPath()
      fs.writeFileSync(configPath, JSON.stringify({ dataDir: this.dataDir }, null, 2), 'utf-8')
    } catch {}
  }

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }

  getDataDir(): string {
    return this.dataDir
  }

  getDbPath(): string {
    return path.join(this.dataDir, 'workavatar.db')
  }

  getKBDbPath(): string {
    return path.join(this.dataDir, 'workavatar-kb.db')
  }

  getKBBasePath(kbId: string): string {
    const dir = path.join(this.dataDir, 'knowledge_bases', kbId)
    this.ensureDir(dir)
    return dir
  }

  getSkillsDir(): string {
    const dir = path.join(this.dataDir, 'skills')
    this.ensureDir(dir)
    return dir
  }

  setDataDir(newDir: string): { success: boolean; error?: string } {
    if (!fs.existsSync(newDir)) {
      try {
        fs.mkdirSync(newDir, { recursive: true })
      } catch {
        return { success: false, error: '无法创建目录' }
      }
    }

    const testFile = path.join(newDir, '.workavatar-write-test')
    try {
      fs.writeFileSync(testFile, 'test')
      fs.unlinkSync(testFile)
    } catch {
      return { success: false, error: '目录不可写' }
    }

    this.dataDir = newDir
    this.ensureDir(this.dataDir)
    this.writeConfig()

    return { success: true }
  }
}

export default PathService
