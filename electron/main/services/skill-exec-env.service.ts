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
    // scriptName 仅允许文件名，不能含路径分隔符或 ..
    if (/[\/\\]|\.\./.test(scriptName)) return null
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

      let stdout = ''
      let stderr = ''

      child.stdout?.on('data', (data) => {
        stdout += data.toString()
        if (stdout.length > MAX_OUTPUT) stdout = stdout.substring(0, MAX_OUTPUT)
      })
      child.stderr?.on('data', (data) => {
        stderr += data.toString()
        if (stderr.length > MAX_OUTPUT) stderr = stderr.substring(0, MAX_OUTPUT)
      })

      child.on('error', (err) => {
        resolve({
          success: false,
          stdout,
          stderr: stderr + `\n[spawn error: ${err.message}]`,
          exitCode: null,
          durationMs: Date.now() - startTime,
        })
      })

      child.on('close', (code) => {
        resolve({
          success: code === 0,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: code,
          durationMs: Date.now() - startTime,
        })
      })
    })
  }
}

export default SkillExecEnvService
