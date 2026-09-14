import type { ToolDefinition } from './types'
import * as vm from 'vm'
import * as path from 'path'
import * as fs from 'fs'
import FilePermissionService, { type ScriptConfirmInput } from '../../file-permission.service'
import { getWorkspacePath } from './fs-tools'
import { isFileDeletionCommand } from './command-analyzer'

/** 脚本触发确认时下发给弹窗的语言标识 */
const SCRIPT_LANGUAGE = 'javascript'

/**
 * 脚本内删除被拒绝时的提示：删除统一走 file_delete 工具。
 * 与 shell-exec.tool.ts 的 DELETION_FORBIDDEN_HINT 保持同一引导方向。
 */
const DELETION_FORBIDDEN_IN_CODE =
  '删除操作已被安全策略禁止通过脚本执行（含 file.delete 与 fs.unlink/rm/rmdir 等删除原语）：' +
  '请改用 file_delete 工具删除文件或目录（path 传绝对路径，删除非空目录加 recursive=true；删除会移入回收站，可恢复）。' +
  '请从代码中移除删除逻辑，临时文件在脚本结束后用 file_delete 删除。'

/** 删除类代码检测：复用命令分类器，并补充沙箱独有的 file.delete / file["delete"] */
function hasDeletionCode(code: string): boolean {
  return isFileDeletionCommand(code) || /\bfile\s*(?:\.\s*delete|\[\s*['"`]delete['"`]\s*\])\s*\(/.test(code)
}

const filePermission = FilePermissionService.getInstance()

const OFFICE_MODULES: Record<string, any> = {}
const MODULE_LOAD_ERRORS: Record<string, string> = {}

function loadOfficeModules() {
  // 必须用字符串字面量 require，Vite 才能正确外部化（变量 require 会被打包导致 ESM 模块加载失败）
  try { OFFICE_MODULES['docx'] = require('docx') } catch (e: any) { MODULE_LOAD_ERRORS['docx'] = e.message || String(e) }
  try { OFFICE_MODULES['pptxgenjs'] = require('pptxgenjs') } catch (e: any) { MODULE_LOAD_ERRORS['pptxgenjs'] = e.message || String(e) }
  try { OFFICE_MODULES['xlsx'] = require('xlsx') } catch (e: any) { MODULE_LOAD_ERRORS['xlsx'] = e.message || String(e) }
  try { OFFICE_MODULES['adm-zip'] = require('adm-zip') } catch (e: any) { MODULE_LOAD_ERRORS['adm-zip'] = e.message || String(e) }
}

loadOfficeModules()

// 移除 'os' 模块：os.hostname()/userInfo()/networkInterfaces() 等会泄漏系统敏感信息
const ALLOWED_NODE_MODULES = ['fs', 'path', 'stream', 'buffer', 'util', 'crypto']

/** 沙箱中允许暴露给 LLM 生成代码的环境变量白名单（避免泄漏 API key、数据库路径等敏感信息） */
const ALLOWED_ENV_KEYS = ['PATH', 'Path', 'TEMP', 'TMP', 'OS', 'PLATFORM', 'LANG', 'LC_ALL', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']

const MAX_CONSOLE_OUTPUT = 10000

/**
 * 从 JS 代码中提取**写/删上下文**中的绝对路径（用于执行前预扫描与非工作区确认）。
 * 只提取会被写入/删除的路径，不提取仅读取的路径（如 inspect/readFileSync 的参数）。
 */
function extractWritePathsFromCode(code: string): string[] {
  const paths: string[] = []
  let m: RegExpExecArray | null

  // 1. file 对象写方法：路径为第一个字符串参数（file.save/append/delete/createFolder 第1参，file.copy/move 第2参即 dest）
  const fileWriteRe = /file\.(save|append|delete|createFolder)\s*\(\s*["'`]([A-Za-z]:[\\/][^"'`\n]*|\/[^"'`\n]+)["'`]/g
  while ((m = fileWriteRe.exec(code)) !== null) {
    if (!m[2].includes('node_modules')) paths.push(m[2])
  }
  const fileCopyMoveRe = /file\.(copy|move)\s*\([^,]*,\s*["'`]([A-Za-z]:[\\/][^"'`\n]*|\/[^"'`\n]+)["'`]/g
  while ((m = fileCopyMoveRe.exec(code)) !== null) {
    if (!m[2].includes('node_modules')) paths.push(m[2])
  }

  // 2. xlsx.writeFile / xlsx.writeFileSync：第二个参数为 outputPath
  const xlsxWriteRe = /(?:XLSX|xlsx)\.(?:writeFile|writeFileSync)\s*\(\s*[^,]+,\s*["'`]([A-Za-z]:[\\/][^"'`\n]*|\/[^"'`\n]+)["'`]/g
  while ((m = xlsxWriteRe.exec(code)) !== null) {
    if (!m[1].includes('node_modules')) paths.push(m[1])
  }

  // 3. pptxgenjs writeFile({ fileName: "..." })
  const pptxWriteRe = /\.writeFile\s*\(\s*\{[^}]*fileName\s*:\s*["'`]([A-Za-z]:[\\/][^"'`\n]*|\/[^"'`\n]+)["'`]/g
  while ((m = pptxWriteRe.exec(code)) !== null) {
    if (!m[1].includes('node_modules')) paths.push(m[1])
  }

  // 4. adm-zip writeZip / writeZipPromise
  const admZipWriteRe = /\.writeZip(?:Promise)?\s*\(\s*["'`]([A-Za-z]:[\\/][^"'`\n]*|\/[^"'`\n]+)["'`]/g
  while ((m = admZipWriteRe.exec(code)) !== null) {
    if (!m[1].includes('node_modules')) paths.push(m[1])
  }

  return [...new Set(paths)]
}

/** 语法检查结果 */
interface SyntaxCheckResult {
  valid: boolean
  error?: string
  line?: number
  column?: number
  context?: string
  hint?: string
}

/**
 * 检查 JS 代码语法（不执行）。
 * 用 vm.Script 预编译，语法错误在此阶段抛出，避免完整执行后才发现 SyntaxError。
 */
function checkCodeSyntax(code: string): SyntaxCheckResult {
  const wrappedCode = `(async () => {\n${code}\n})()`
  try {
    new vm.Script(wrappedCode, { filename: 'js-exec.js' })
    return { valid: true }
  } catch (e: any) {
    const errorMsg = e.message || String(e)
    const stack = e.stack || ''

    let line: number | undefined
    let column: number | undefined
    const lineMatch = stack.match(/js-exec\.js:(\d+)(?::(\d+))?/)
    if (lineMatch) {
      line = parseInt(lineMatch[1], 10)
      if (lineMatch[2]) column = parseInt(lineMatch[2], 10)
      if (line > 1) line -= 1 // 用户代码从第 2 行开始（第 1 行是 async 包装）
    }

    let context: string | undefined
    if (line && line > 0) {
      const codeLines = code.split('\n')
      const errorIdx = line - 1
      if (errorIdx >= 0 && errorIdx < codeLines.length) {
        const startIdx = Math.max(0, errorIdx - 3)
        const endIdx = Math.min(codeLines.length - 1, errorIdx + 2)
        const ctxLines: string[] = []
        for (let i = startIdx; i <= endIdx; i++) {
          const marker = i === errorIdx ? ' >>> ' : '     '
          ctxLines.push(`${marker}${i + 1} | ${codeLines[i]}`)
        }
        context = ctxLines.join('\n')
      }
    }

    let hint = ''
    if (/Unterminated string literal|Unexpected string|Unexpected identifier/i.test(errorMsg)) {
      hint = "常见原因：字符串引号冲突。建议：1) 外层用单引号 '...'；2) 或用反引号 `...`（支持多行）；3) 或转义内部双引号 \\\""
    } else if (/Unexpected token/i.test(errorMsg)) {
      hint = '常见原因：特殊字符未转义。检查字符串中是否含未转义的引号、反斜杠等'
    } else if (/is not defined/i.test(errorMsg)) {
      hint = '变量未定义。检查拼写、是否忘记 require 模块。沙箱可用模块：docx、pptxgenjs、xlsx、adm-zip、fs、path、file'
    } else if (/Unexpected end of input/i.test(errorMsg)) {
      hint = '代码不完整（括号/引号未闭合）。检查是否缺少闭合的 )、}、]、\'、"、`'
    }

    return { valid: false, error: errorMsg, line, column, context, hint }
  }
}

/**
 * 创建沙箱只读 fs：仅放行读类方法（白名单制，防止未来 fs API 漂移产生绕过），
 * 其余方法（写/删/改元数据/open 系列）统一替换为抛错提示用 `file` 对象。
 * 写操作不走 fs（同步方法无法 await 异步弹窗），由注入的 `file` 异步对象处理。
 */
function createSandboxedReadOnlyFs(): any {
  const realFs = require('fs')
  const wrappedFs: any = {}
  // 读类白名单：只有这些方法暴露给沙箱
  const allowedMethods = new Set([
    'readFileSync', 'existsSync', 'statSync', 'lstatSync', 'fstatSync',
    'readdirSync', 'readlinkSync', 'realpathSync', 'opendirSync',
    'accessSync', 'constants', 'Stats', 'Dir', 'Dirent',
    'createReadStream',
  ])
  const blockedMsg = 'javascript_exec 沙箱中 fs 不支持写/删操作。写入请使用注入的 `file` 对象（如 await file.save(path, content)）；删除请使用 file_delete 工具。'
  for (const key of Object.keys(realFs)) {
    if (allowedMethods.has(key)) {
      wrappedFs[key] = realFs[key]
    }
  }
  // createReadStream 特殊处理：固定只读 flag。options.flags 可传 'w' 以 O_TRUNC
  // 打开目标文件（随后 read 报 EBADF 但文件已被清空），构成任意路径文件破坏
  wrappedFs.createReadStream = (p: any, opts: any) => realFs.createReadStream(p, { ...opts, flags: 'r' })
  // fs.promises：同样只放行读类方法
  if (realFs.promises) {
    const realPromises = realFs.promises
    const wrappedPromises: any = {}
    const allowedPromiseMethods = new Set([
      'readFile', 'stat', 'lstat', 'readdir', 'readlink', 'realpath',
      'opendir', 'access', 'constants',
    ])
    for (const key of Object.keys(realPromises)) {
      if (allowedPromiseMethods.has(key)) {
        wrappedPromises[key] = realPromises[key]
      }
    }
    wrappedFs.promises = wrappedPromises
  }
  // 占位抛错：避免 LLM 生成的代码调用写方法时得到 undefined is not a function 而难以定位
  for (const key of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'unlink', 'unlinkSync',
    'rm', 'rmSync', 'rmdir', 'rmdirSync', 'mkdir', 'mkdirSync', 'copyFile', 'copyFileSync',
    'rename', 'renameSync', 'truncate', 'truncateSync', 'ftruncate', 'ftruncateSync',
    'open', 'openSync', 'write', 'writeSync', 'writev', 'writevSync',
    'chmod', 'chmodSync', 'chown', 'chownSync', 'utimes', 'utimesSync',
    'link', 'linkSync', 'symlink', 'symlinkSync', 'createWriteStream']) {
    wrappedFs[key] = () => { throw new Error(blockedMsg) }
    if (realFs.promises) {
      wrappedFs.promises[key] = () => Promise.reject(new Error(blockedMsg))
    }
  }
  return wrappedFs
}

/**
 * 创建异步 `file` 对象：沙箱代码用 `await file.save(path, content)` 等异步方法写文件。
 * 内部经 FilePermissionService 统一授权（区内自动通过，区外弹窗确认）。
 * 相对路径以沙箱工作目录（注入给脚本的 __dirname/__workspaceDir）为基准解析。
 */
function createSandboxedFile(
  authorizedPaths: Set<string>,
  workingDir: string,
  script: ScriptConfirmInput,
): any {
  const checkAndAuthorize = async (operation: string, targetPath: string): Promise<void> => {
    if (typeof targetPath !== 'string') return
    let resolved: string
    try { resolved = path.resolve(workingDir, targetPath) } catch { return }
    if (authorizedPaths.has(resolved.toLowerCase())) return
    const result = await filePermission.authorizeFileOperation(operation, [resolved], { script })
    if (!result.allowed) {
      throw new Error(result.error || `用户取消了${operation}工作区外文件的操作`)
    }
    authorizedPaths.add(resolved.toLowerCase())
  }

  /** 相对路径统一基于工作目录解析，授权判定与实际 fs 调用必须使用同一路径 */
  const resolveInWorkspace = (p: string): string => path.resolve(workingDir, p)

  return {
    save: async (filePath: string, content: string | Buffer): Promise<void> => {
      await checkAndAuthorize('写入', filePath)
      fs.writeFileSync(resolveInWorkspace(filePath), content)
    },
    append: async (filePath: string, content: string | Buffer): Promise<void> => {
      await checkAndAuthorize('追加', filePath)
      fs.appendFileSync(resolveInWorkspace(filePath), content)
    },
    copy: async (src: string, dest: string): Promise<void> => {
      await checkAndAuthorize('复制至', dest)
      fs.copyFileSync(resolveInWorkspace(src), resolveInWorkspace(dest))
    },
    move: async (src: string, dest: string): Promise<void> => {
      await checkAndAuthorize('移动至', dest)
      fs.renameSync(resolveInWorkspace(src), resolveInWorkspace(dest))
    },
    // 脚本内删除一律拒绝：删除必须走 file_delete 工具（路径可静态判定、移入回收站可恢复、操作可审计）
    delete: async (_filePath: string): Promise<void> => {
      throw new Error(DELETION_FORBIDDEN_IN_CODE)
    },
    createFolder: async (folderPath: string): Promise<void> => {
      await checkAndAuthorize('创建文件夹于', folderPath)
      fs.mkdirSync(resolveInWorkspace(folderPath), { recursive: true })
    },
    exists: (filePath: string): boolean => {
      return fs.existsSync(resolveInWorkspace(filePath))
    },
  }
}

/**
 * 包装 xlsx / pptxgenjs / adm-zip 模块：写函数经 FilePermissionService 统一授权。
 * 相对路径以沙箱工作目录为基准；adm-zip 的同步写无法 await 弹窗，
 * 由执行前预扫描授权字面量路径，运行时仅做同步边界校验（未授权即拒）。
 */
function createSandboxedRequire(
  authorizedPaths: Set<string>,
  sandboxFile: any,
  workingDir: string,
  script: ScriptConfirmInput,
) {
  let cachedFs: any = null
  let cachedXlsx: any = null
  let cachedPptxgenjs: any = null
  let cachedAdmZip: any = null

  /** 检查路径权限，工作区外路径异步弹窗确认 */
  const checkAndAuthorize = async (operation: string, targetPath: string): Promise<void> => {
    if (typeof targetPath !== 'string') return
    let resolved: string
    try { resolved = path.resolve(workingDir, targetPath) } catch { return }
    if (authorizedPaths.has(resolved.toLowerCase())) return
    const result = await filePermission.authorizeFileOperation(operation, [resolved], { script })
    if (!result.allowed) {
      throw new Error(result.error || `用户取消了${operation}工作区外文件的操作`)
    }
    authorizedPaths.add(resolved.toLowerCase())
  }

  /** 同步写场景的边界校验：区内或已授权放行，否则直接拒绝（引导走预扫描/ file.save） */
  const assertSyncWriteAllowed = (targetPath: unknown): void => {
    if (typeof targetPath !== 'string') return
    const resolved = path.resolve(workingDir, targetPath)
    if (authorizedPaths.has(resolved.toLowerCase())) return
    if (filePermission.isPathAuthorized(resolved)) return
    throw new Error(
      `写入工作区外路径需先获得授权: ${resolved}。请将输出路径以字符串字面量直接传入 writeZip（执行前会弹窗确认），或改用 await file.save() 写入`,
    )
  }

  return (moduleName: string) => {
    // xlsx：writeFile 是同步方法，包装为异步
    if (moduleName === 'xlsx' && OFFICE_MODULES['xlsx']) {
      if (!cachedXlsx) {
        const rawXlsx = OFFICE_MODULES['xlsx']
        const originalWriteFile = rawXlsx.writeFile
        const originalWriteFileSync = rawXlsx.writeFileSync || rawXlsx.writeFile
        cachedXlsx = { ...rawXlsx }
        cachedXlsx.writeFile = async (wb: any, filename: string, opts?: any) => {
          const target = path.resolve(workingDir, filename)
          await checkAndAuthorize('写入', target)
          return originalWriteFile.call(rawXlsx, wb, target, opts)
        }
        cachedXlsx.writeFileSync = async (wb: any, filename: string, opts?: any) => {
          const target = path.resolve(workingDir, filename)
          await checkAndAuthorize('写入', target)
          return originalWriteFileSync.call(rawXlsx, wb, target, opts)
        }
      }
      return cachedXlsx
    }
    // pptxgenjs：实例方法 writeFile({ fileName }) 返回 Promise
    if (moduleName === 'pptxgenjs' && OFFICE_MODULES['pptxgenjs']) {
      if (!cachedPptxgenjs) {
        cachedPptxgenjs = class extends OFFICE_MODULES['pptxgenjs'] {
          writeFile(options: any) {
            const fileName = typeof options === 'string' ? options : options?.fileName
            const target = path.resolve(workingDir, fileName)
            return checkAndAuthorize('写入', target).then(() => {
              const finalOptions = typeof options === 'string' ? target : { ...options, fileName: target }
              return super.writeFile(finalOptions)
            })
          }
        }
      }
      return cachedPptxgenjs
    }
    // adm-zip：模块导出是工厂函数（调用后返回带自有 writeZip 方法的对象字面量，非原型方法），
    // class extends 会被父构造器返回的原始对象整体遮蔽，必须直接包装工厂返回的实例。
    // writeZip/writeZipPromise 同步落盘：执行前预扫描授权字面量路径，运行时同步边界校验
    if (moduleName === 'adm-zip' && OFFICE_MODULES['adm-zip']) {
      if (!cachedAdmZip) {
        const RawAdmZip = OFFICE_MODULES['adm-zip']
        cachedAdmZip = function (this: unknown, ...args: any[]) {
          const instance: any = RawAdmZip(...args)
          const rawWriteZip = instance.writeZip.bind(instance)
          const rawWriteZipPromise = instance.writeZipPromise.bind(instance)
          const guard = (targetPath: unknown) => {
            assertSyncWriteAllowed(targetPath)
            return typeof targetPath === 'string' ? path.resolve(workingDir, targetPath) : targetPath
          }
          instance.writeZip = (targetPath: any, ...rest: any[]) => rawWriteZip(guard(targetPath), ...rest)
          instance.writeZipPromise = (targetPath: any, ...rest: any[]) => rawWriteZipPromise(guard(targetPath), ...rest)
          return instance
        }
      }
      return cachedAdmZip
    }
    // 其他 OFFICE_MODULES 直接返回（不涉及文件写入）
    if (OFFICE_MODULES[moduleName]
      && moduleName !== 'xlsx' && moduleName !== 'pptxgenjs' && moduleName !== 'adm-zip') {
      return OFFICE_MODULES[moduleName]
    }
    if (moduleName === 'fs') {
      if (!cachedFs) cachedFs = createSandboxedReadOnlyFs()
      return cachedFs
    }
    if (moduleName === 'file') {
      return sandboxFile
    }
    if (ALLOWED_NODE_MODULES.includes(moduleName)) return require(moduleName)
    const available = [
      ...Object.keys(OFFICE_MODULES).filter(k => OFFICE_MODULES[k]),
      'fs', 'file',
      ...ALLOWED_NODE_MODULES,
    ]
    throw new Error(
      `Module "${moduleName}" is not available in the javascript sandbox. Available modules: ${available.join(', ')}`
    )
  }
}

export const javascriptExecTool: ToolDefinition = {
  id: 'javascript_exec',
  name: 'javascript_exec',
  title: 'JavaScript执行',
  summary: 'Node.js沙箱中执行JS代码，自动语法预检查、工作区外写入确认。纯计算/数据处理/写文件类任务用此，不要用shell_exec调node。',
  description: `在Node.js沙箱中执行JavaScript代码（支持async/await）。

写JS代码用此工具，不要用shell_exec调node。

短代码(<800字)传 code；长代码用 file_write 写 .js 后传 code_file。
文件写入用 await file.save(path, content)，不要用 fs 写方法。
删除文件/目录用 file_delete 工具；脚本内不要写删除逻辑（file.delete、fs.unlink/rm/rmdir 等会被拒绝）。
执行前语法预检查，精确行号+修复建议。
字符串↔字节编码用 Buffer（require('buffer') 或全局 Buffer），沙箱内没有 TextEncoder/TextDecoder。`,
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: '要执行的JavaScript代码，支持async/await。短代码（<800字符）建议直接传此参数' },
      code_file: { type: 'string', description: '本地 .js 文件绝对路径，读取该文件内容作为代码执行。长代码（≥800字符）建议先用 file_write 写入文件再传此参数，避免 JSON 转义导致引号错误。code 与 code_file 二选一，同时传时 code_file 优先' },
      working_dir: { type: 'string', description: '工作目录（文件操作基准路径），默认为当前员工工作区' },
      timeout: { type: 'number', description: '超时时间（秒），默认60秒，最大300秒', minimum: 1, maximum: 300 },
    },
    required: [],
  },
  handler: async (args: any) => {
    let code: string
    const codeFile = String(args.code_file || '').trim()
    if (codeFile) {
      const resolvedCodeFile = path.resolve(codeFile)
      if (!fs.existsSync(resolvedCodeFile)) return { success: false, error: `代码文件不存在: ${codeFile}` }
      if (!fs.statSync(resolvedCodeFile).isFile()) return { success: false, error: `路径不是文件: ${codeFile}` }
      try {
        code = fs.readFileSync(resolvedCodeFile, 'utf-8')
      } catch (e: any) {
        return { success: false, error: `读取代码文件失败: ${e.message || e}` }
      }
      if (!code.trim()) return { success: false, error: '代码文件内容为空' }
    } else {
      code = String(args.code || '').trim()
      if (!code) return { success: false, error: '请提供 code 或 code_file 参数' }
    }

    // 语法预检查：执行前校验 JS 语法，语法错误立即返回（不执行）
    // 消除"完整执行后才发现 SyntaxError"的往返开销
    const syntaxResult = checkCodeSyntax(code)
    if (!syntaxResult.valid) {
      const errorLines: string[] = ['语法错误（未执行）：']
      errorLines.push(`  错误: ${syntaxResult.error}`)
      if (syntaxResult.line) {
        const colInfo = syntaxResult.column ? `:${syntaxResult.column}` : ''
        errorLines.push(`  位置: 第 ${syntaxResult.line} 行${colInfo}`)
      }
      if (syntaxResult.context) {
        errorLines.push('')
        errorLines.push('代码上下文：')
        errorLines.push(syntaxResult.context)
      }
      if (syntaxResult.hint) {
        errorLines.push('')
        errorLines.push(`修复建议: ${syntaxResult.hint}`)
      }
      return {
        success: false,
        error: errorLines.join('\n'),
      }
    }

    // 删除统一走 file_delete：脚本内出现删除原语（file.delete / fs.unlink / fs.rm / rmdir …）直接拒绝，
    // 与 shell_exec 的策略一致，同样不受高权限模式影响
    if (hasDeletionCode(code)) {
      return { success: false, error: DELETION_FORBIDDEN_IN_CODE }
    }

    // 优先使用数字员工工作区目录，其次 LLM 传入的 working_dir，最后 process.cwd()
    const employeeWorkspace = getWorkspacePath()
    const workingDir = String(args.working_dir || employeeWorkspace || process.cwd())
    const timeoutMs = Math.min(Math.max((args.timeout || 60), 1), 300) * 1000

    const consoleOutput: string[] = []

    // 脚本触发：弹窗按"即将执行脚本 + 脚本原文"呈现，不再按单个文件/文件夹措辞
    const scriptInput: ScriptConfirmInput = { language: SCRIPT_LANGUAGE, content: code }

    // 执行前预扫描：提取代码中**写/删上下文**的绝对路径，对区外未授权路径合并为一次弹窗确认
    // 注意：只提取写入/删除路径，不提取读取路径（如 readFileSync 的参数）
    const authorizedPaths = new Set<string>()
    const writePaths = extractWritePathsFromCode(code)
    if (writePaths.length > 0) {
      const result = await filePermission.authorizeFileOperation('修改', writePaths, { script: scriptInput })
      if (!result.allowed) return { success: false, error: result.error }
      for (const p of writePaths) {
        try { authorizedPaths.add(path.resolve(workingDir, p).toLowerCase()) } catch { /* 忽略解析失败的路径 */ }
      }
    }

    const sandboxFile = createSandboxedFile(authorizedPaths, workingDir, scriptInput)
    const sandboxedRequire = createSandboxedRequire(authorizedPaths, sandboxFile, workingDir, scriptInput)

    // 追踪沙箱内创建的定时器，执行结束后统一清理，避免事件循环无法退出
    const trackedTimers: NodeJS.Timeout[] = []
    const wrapTimer = (original: typeof setTimeout | typeof setInterval) => (fn: any, ms?: number, ...args: any[]) => {
      const t = (original as any)(fn, ms, ...args) as NodeJS.Timeout
      trackedTimers.push(t)
      return t
    }
    const wrapImmediate = (original: typeof setImmediate) => (fn: any, ...args: any[]) => {
      const t = (original as any)(fn, ...args) as NodeJS.Timeout
      trackedTimers.push(t)
      return t
    }
    const clearTracked = (t: NodeJS.Timeout) => {
      clearTimeout(t)
      clearInterval(t)
      clearImmediate(t as unknown as NodeJS.Immediate)
      const idx = trackedTimers.indexOf(t)
      if (idx >= 0) trackedTimers.splice(idx, 1)
    }

    const sandbox: Record<string, any> = {
      require: sandboxedRequire,
      file: sandboxFile,
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
        env: Object.fromEntries(
          Object.entries(process.env).filter(([k]) => ALLOWED_ENV_KEYS.includes(k))
        ),
        platform: process.platform,
        versions: process.versions,
        nextTick: process.nextTick,
      },
      Buffer,
      // 注意：刻意不注入 TextEncoder/TextDecoder——它们是宿主类，其实例 constructor
      // 链可达宿主 Function（codeGeneration:false 只禁沙箱内编译，不禁宿主 realm）。
      // 编码需求用 Buffer（require('buffer')）替代；其余 TypedArray/JSON/Math 等为
      // V8 intrinsic，沙箱自带
      setTimeout: wrapTimer(setTimeout),
      clearTimeout: clearTracked,
      setInterval: wrapTimer(setInterval),
      clearInterval: clearTracked,
      setImmediate: wrapImmediate(setImmediate),
      clearImmediate: clearTracked,
    }

    try {
      // codeGeneration.strings=false：禁用 eval / new Function 的字符串编译。
      // 即使沙箱代码经 x.constructor.constructor 拿到宿主 realm 的 Function 构造器，
      // 也无法用它编译新代码，逃逸链在编译环节被切断（host intrinsics 也不再注入，
      // 沙箱使用自己 realm 的 Object/Promise/Array 等，避免跨 realm 混淆）。
      const context = vm.createContext(sandbox, {
        codeGeneration: { strings: false, wasm: false },
      })

      const wrappedCode = `(async () => {\n${code}\n})()`
      const script = new vm.Script(wrappedCode, { filename: 'js-exec.js' })

      const resultPromise = script.runInContext(context, { timeout: timeoutMs })

      let asyncTimer: NodeJS.Timeout | undefined
      const asyncTimeoutPromise = new Promise<never>((_, reject) => {
        asyncTimer = setTimeout(() => reject(new Error('执行超时（异步操作未在规定时间内完成）')), timeoutMs)
      })

      try {
        await Promise.race([resultPromise, asyncTimeoutPromise])
      } finally {
        if (asyncTimer) clearTimeout(asyncTimer)
        for (const t of trackedTimers) {
          clearTimeout(t)
          clearInterval(t)
          clearImmediate(t as unknown as NodeJS.Immediate)
        }
        trackedTimers.length = 0
      }

      let output = consoleOutput.join('\n')
      if (output.length > MAX_CONSOLE_OUTPUT) {
        output = output.substring(0, MAX_CONSOLE_OUTPUT / 2)
          + `\n\n... (${output.length - MAX_CONSOLE_OUTPUT} 字符已截断) ...\n\n`
          + output.substring(output.length - MAX_CONSOLE_OUTPUT / 2)
      }

      const parts: string[] = ['[javascript_exec] 执行成功']

      if (output) {
        parts.push('--- stdout ---')
        parts.push(output)
      }

      return {
        success: true,
        output: parts.join('\n'),
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
          (line: string) => line.includes('js-exec.js') || line.includes('Error')
        )
        if (relevantLines.length > 0 && relevantLines.length < stackLines.length) {
          errorMessage = relevantLines.join('\n')
        }
      }

      const statusBlock = '[javascript_exec] 执行失败'
      const finalOutput = [statusBlock, output].filter(Boolean).join('\n')

      return {
        success: false,
        error: errorMessage,
        output: finalOutput || undefined,
      }
    }
  },
  source: 'builtin',
  onDemand: true,
  // timeout 参数上限 300s，工具级超时须不小于该上限（否则中间件默认超时/此值会先截断用户指定的长任务）
  timeoutMs: 310_000,
}

export function getJavascriptModuleStatus(): Record<string, { loaded: boolean; error?: string }> {
  const status: Record<string, { loaded: boolean; error?: string }> = {}
  for (const name of ['docx', 'pptxgenjs', 'xlsx', 'adm-zip']) {
    status[name] = {
      loaded: !!OFFICE_MODULES[name],
      error: MODULE_LOAD_ERRORS[name],
    }
  }
  return status
}
