import { spawn } from 'child_process'
import path from 'path'
import SkillRegistryService from './skill-registry.service'
import { createLogger } from './logger'

const logger = createLogger('SkillExecEnv')

export interface ScriptExecutionResult {
  success: boolean
  stdout: string
  stderr: string
  exitCode: number | null
  durationMs: number
}

const MAX_OUTPUT = 100 * 1024 // 100KB

/** 输出超限时的截断标记：明确告知调用方输出不完整，而不是静默丢弃 */
function truncationMark(limit: number): string {
  return `\n...[输出已截断，仅保留前 ${limit} 字符]`
}

interface OutputBuffer {
  text: string
  /** 已截断：后续数据直接丢弃，避免反复拼接巨型字符串 */
  truncated: boolean
}

/** 累积子进程输出，超过上限时截断并追加截断标记 */
function appendOutput(buffer: OutputBuffer, chunk: string): void {
  if (buffer.truncated) return
  buffer.text += chunk
  if (buffer.text.length > MAX_OUTPUT) {
    buffer.text = buffer.text.substring(0, MAX_OUTPUT) + truncationMark(MAX_OUTPUT)
    buffer.truncated = true
  }
}

class SkillExecEnvService {
  private static instance: SkillExecEnvService
  private skillRegistry: SkillRegistryService

  private constructor() {
    this.skillRegistry = SkillRegistryService.getInstance()
  }

  static getInstance(): SkillExecEnvService {
    if (!SkillExecEnvService.instance) {
      SkillExecEnvService.instance = new SkillExecEnvService()
    }
    return SkillExecEnvService.instance
  }

  // 根据 scriptName 找到 skill 的脚本路径，防止路径穿越
  resolveScriptPath(skillId: string, scriptName: string): string | null {
    const skill = this.skillRegistry.getSkillById(skillId)
    if (!skill) return null
    // scriptName 仅允许纯文件名：含路径分隔符（跨目录）或 .. 路径段（目录穿越）一律拒绝。
    // 按路径段判定而非裸匹配 ".."，避免误杀 a..b.js 这类合法文件名
    const segments = scriptName.split(/[\\/]/)
    if (segments.length > 1 || segments.includes('..')) return null
    const script = skill.scripts.find((s) => s.name === scriptName)
    return script ? script.path : null
  }

  // 执行脚本：.py → python, .js/.mjs → node, .sh → bash/sh
  async executeScript(
    skillId: string,
    scriptName: string,
    args: string[] = [],
    options: { timeoutMs?: number } = {}
  ): Promise<ScriptExecutionResult> {
    const scriptPath = this.resolveScriptPath(skillId, scriptName)
    if (!scriptPath) {
      return {
        success: false,
        stdout: '',
        stderr: `Script "${scriptName}" not found in skill ${skillId}`,
        exitCode: null,
        durationMs: 0,
      }
    }

    const ext = path.extname(scriptPath).toLowerCase()
    const timeoutMs = options.timeoutMs ?? 30000
    const startTime = Date.now()

    let command: string
    let commandArgs: string[]

    switch (ext) {
      case '.py':
        command = process.platform === 'win32' ? 'python' : 'python3'
        commandArgs = [scriptPath, ...args]
        break
      case '.js':
      case '.mjs':
        command = 'node'
        commandArgs = [scriptPath, ...args]
        break
      case '.sh':
        command = process.platform === 'win32' ? 'bash' : 'sh'
        commandArgs = [scriptPath, ...args]
        break
      default:
        return {
          success: false,
          stdout: '',
          stderr: `Unsupported script type: ${ext} (only .py/.sh/.js supported)`,
          exitCode: null,
          durationMs: 0,
        }
    }

    logger.info(`Executing skill script: ${command} ${commandArgs.join(' ')}`)

    return new Promise((resolve) => {
      const child = spawn(command, commandArgs, {
        cwd: path.dirname(scriptPath),
        timeout: timeoutMs,
        env: { ...process.env },
      })

      const stdoutBuffer: OutputBuffer = { text: '', truncated: false }
      const stderrBuffer: OutputBuffer = { text: '', truncated: false }

      child.stdout?.on('data', (data) => appendOutput(stdoutBuffer, data.toString()))
      child.stderr?.on('data', (data) => appendOutput(stderrBuffer, data.toString()))

      child.on('error', (err) => {
        resolve({
          success: false,
          stdout: stdoutBuffer.text,
          stderr: stderrBuffer.text + `\n[spawn error: ${err.message}]`,
          exitCode: null,
          durationMs: Date.now() - startTime,
        })
      })

      child.on('close', (code) => {
        resolve({
          success: code === 0,
          stdout: stdoutBuffer.text.trim(),
          stderr: stderrBuffer.text.trim(),
          exitCode: code,
          durationMs: Date.now() - startTime,
        })
      })
    })
  }
}

export default SkillExecEnvService
