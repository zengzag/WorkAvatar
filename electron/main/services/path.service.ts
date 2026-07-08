import path from 'path'
import fs from 'fs'
import { isMainThread, workerData } from 'worker_threads'
import { createLogger } from './logger'

const logger = createLogger('PathService')

const CONFIG_FILENAME = 'workavatar-path.json'

class PathService {
  private dataDir: string
  private static instance: PathService

  private constructor() {
    // Worker 模式：直接使用主线程通过 workerData 传入的 dataDir
    // 避免依赖 electron.app（worker_threads 中不可用）
    if (!isMainThread && workerData?.dataDir) {
      this.dataDir = workerData.dataDir as string
      this.ensureDir(this.dataDir)
      return
    }

    // 主线程模式：从 electron.app 读取默认目录或用户配置
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
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron')
    return path.join(app.getPath('documents'), 'WorkAvatar')
  }

  private getConfigPath(): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron')
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
    } catch (error) {
      logger.warn('Failed to write path config', error)
    }
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

  getKMSDbPath(): string {
    return path.join(this.dataDir, 'workavatar-kms.db')
  }

  /**
   * KMS 向量库独立文件路径。
   *
   * 把 kms_embeddings + vec_kms_embeddings 从主库分离出来，让主库（workavatar-kms.db）
   * 体积减小、checkpoint 更快，向量库的 BLOB 写入不影响主库的读取性能。
   */
  getKMSVectorDbPath(): string {
    return path.join(this.dataDir, 'workavatar-kms-vectors.db')
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
