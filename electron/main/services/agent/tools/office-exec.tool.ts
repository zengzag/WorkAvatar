import type { ToolDefinition } from './types'
import * as vm from 'vm'

const OFFICE_MODULES: Record<string, any> = {}
const MODULE_LOAD_ERRORS: Record<string, string> = {}

function loadOfficeModules() {
  const modules = ['docx', 'pptxgenjs', 'xlsx', 'adm-zip']
  for (const name of modules) {
    try {
      OFFICE_MODULES[name] = require(name)
    } catch (e: any) {
      MODULE_LOAD_ERRORS[name] = e.message || String(e)
    }
  }
}

loadOfficeModules()

const ALLOWED_NODE_MODULES = ['fs', 'path', 'os', 'stream', 'buffer', 'util', 'crypto']

const MAX_CONSOLE_OUTPUT = 10000

function createSandboxedRequire() {
  return (moduleName: string) => {
    if (OFFICE_MODULES[moduleName]) return OFFICE_MODULES[moduleName]
    if (ALLOWED_NODE_MODULES.includes(moduleName)) return require(moduleName)
    const available = [
      ...Object.keys(OFFICE_MODULES).filter(k => OFFICE_MODULES[k]),
      ...ALLOWED_NODE_MODULES,
    ]
    throw new Error(
      `Module "${moduleName}" is not available in the office sandbox. Available modules: ${available.join(', ')}`
    )
  }
}

export const officeExecTool: ToolDefinition = {
  id: 'office_exec',
  name: 'office_exec',
  title: 'Office文档生成',
  description: '在Node.js沙箱中执行JavaScript代码，创建或编辑Office文档（Word/PowerPoint/Excel）。使用前请先调用 office_guide 获取详细使用说明和代码模板。',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: '要执行的JavaScript代码，支持async/await' },
      working_dir: { type: 'string', description: '工作目录（文件操作基准路径），默认为当前员工工作区' },
      timeout: { type: 'number', description: '超时时间（秒），默认60秒，最大300秒', minimum: 1, maximum: 300 },
    },
    required: ['code'],
  },
  handler: async (args: any) => {
    const code = String(args.code || '').trim()
    if (!code) return { success: false, error: '代码不能为空' }

    const workingDir = String(args.working_dir || process.cwd())
    const timeoutMs = Math.min(Math.max((args.timeout || 60), 1), 300) * 1000

    const consoleOutput: string[] = []

    const sandboxedRequire = createSandboxedRequire()

    const sandbox: Record<string, any> = {
      require: sandboxedRequire,
      console: {
        log: (...a: any[]) => consoleOutput.push(a.map(v => typeof v === 'object' ? JSON.stringify(v) : String(v)).join(' ')),
        error: (...a: any[]) => consoleOutput.push('[ERROR] ' + a.map(v => typeof v === 'object' ? JSON.stringify(v) : String(v)).join(' ')),
        warn: (...a: any[]) => consoleOutput.push('[WARN] ' + a.map(v => typeof v === 'object' ? JSON.stringify(v) : String(v)).join(' ')),
        info: (...a: any[]) => consoleOutput.push(a.map(v => typeof v === 'object' ? JSON.stringify(v) : String(v)).join(' ')),
      },
      __workspaceDir: workingDir,
      __dirname: workingDir,
      process: {
        cwd: () => workingDir,
        env: { ...process.env },
        platform: process.platform,
        versions: process.versions,
        nextTick: process.nextTick,
      },
      Buffer,
      Uint8Array,
      ArrayBuffer,
      Int8Array,
      Uint16Array,
      Int16Array,
      Uint32Array,
      Int32Array,
      Float32Array,
      Float64Array,
      DataView,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      setImmediate,
      clearImmediate,
      Promise,
      JSON,
      Math,
      Date,
      Error,
      TypeError,
      RangeError,
      SyntaxError,
      ReferenceError,
      URIError,
      EvalError,
      Object,
      Array,
      String,
      Number,
      Boolean,
      Symbol,
      Map,
      Set,
      WeakMap,
      WeakSet,
      RegExp,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      encodeURIComponent,
      decodeURIComponent,
      encodeURI,
      decodeURI,
      TextEncoder,
      TextDecoder,
      undefined,
      NaN,
      Infinity,
    }

    try {
      const context = vm.createContext(sandbox)
      const wrappedCode = `(async () => {\n${code}\n})()`
      const script = new vm.Script(wrappedCode, { filename: 'office-exec.js' })

      const resultPromise = script.runInContext(context, { timeout: timeoutMs })

      const asyncTimeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('执行超时（异步操作未在规定时间内完成）')), timeoutMs)
      )

      await Promise.race([resultPromise, asyncTimeoutPromise])

      let output = consoleOutput.join('\n')
      if (output.length > MAX_CONSOLE_OUTPUT) {
        output = output.substring(0, MAX_CONSOLE_OUTPUT / 2)
          + `\n\n... (${output.length - MAX_CONSOLE_OUTPUT} 字符已截断) ...\n\n`
          + output.substring(output.length - MAX_CONSOLE_OUTPUT / 2)
      }

      return {
        success: true,
        consoleOutput: output || undefined,
      }
    } catch (error: any) {
      let output = consoleOutput.join('\n')
      if (output.length > MAX_CONSOLE_OUTPUT) {
        output = output.substring(0, MAX_CONSOLE_OUTPUT / 2)
          + `\n\n... (截断) ...\n\n`
          + output.substring(output.length - MAX_CONSOLE_OUTPUT / 2)
      }

      let errorMessage = error.message || String(error)

      if (error.stack) {
        const stackLines = error.stack.split('\n')
        const relevantLines = stackLines.filter(
          (line: string) => line.includes('office-exec.js') || line.includes('Error')
        )
        if (relevantLines.length > 0 && relevantLines.length < stackLines.length) {
          errorMessage = relevantLines.join('\n')
        }
      }

      return {
        success: false,
        error: errorMessage,
        consoleOutput: output || undefined,
      }
    }
  },
  source: 'builtin',
  timeoutMs: 120000,
}

export function getOfficeModuleStatus(): Record<string, { loaded: boolean; error?: string }> {
  const status: Record<string, { loaded: boolean; error?: string }> = {}
  for (const name of ['docx', 'pptxgenjs', 'xlsx', 'adm-zip']) {
    status[name] = {
      loaded: !!OFFICE_MODULES[name],
      error: MODULE_LOAD_ERRORS[name],
    }
  }
  return status
}
