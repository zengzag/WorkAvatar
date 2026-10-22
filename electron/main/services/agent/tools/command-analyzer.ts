/**
 * 命令文本的通道策略检测（不是安全边界）：
 * - 删除原语：产品规定删除统一走 file_delete（回收站可恢复），命令/脚本里出现删除即拒绝
 * - 被解释器执行的脚本文件：继续检查脚本内容，覆盖"先写脚本再执行"的绕过
 *
 * 越界写入不再在这里做路径推断：由沙箱服务在运行期强制（见 sandbox.service.ts）。
 */

// 删除类命令模式
const FILE_DELETION_PATTERNS = [
  /\brm\s+/i, /\bdel\s+/i, /\brmdir\s+/i, /\berase\s+/i,
  /\bRemove-Item\b/i, /\brd\s+\/s/i, /\brd\s+\/q/i,
  // Python / Node.js 脚本删除原语（脚本经 stdin/heredoc/文件执行时同样需要拦截）
  /\bos\.(?:remove|unlink|rmdir|removedirs)\s*\(/,
  /\bshutil\.rmtree\s*\(/,
  // 方法调用形式：p.unlink() / Path(p).unlink(missing_ok=True) / require('fs').unlinkSync(p)
  /\b(?:unlink|unlinkSync|rmdir|rmdirSync|rmSync)\s*\(/,
  /require\(['"](?:node:)?fs['"]\)\s*\.\s*(?:promises\s*\.\s*)?(?:rm|unlink|rmdir)\w*\s*\(/,
  /\.(?:unlink|rmdir)\s*\(\s*\)/,
  /\bfs(?:\.promises)?\.(?:unlink|rm|rmdir)\w*\s*\(/,
  /\bfs\.(?:unlinkSync|rmSync|rmdirSync)\s*\(/,
]

/** 包管理器 rm 子命令（npm rm / yarn rm / pnpm rm / bun rm）只改依赖清单，不删除本地文件，不应按删除拦截 */
const PKG_MANAGER_RM_RE = /\b(?:npm|yarn|pnpm|bun)\s+rm\b/gi

export function isFileDeletionCommand(command: string): boolean {
  const cleaned = command.replace(PKG_MANAGER_RM_RE, ' ')
  return FILE_DELETION_PATTERNS.some(p => p.test(cleaned))
}

/** 交给解释器执行的脚本文件后缀（用于把删除检测从命令文本扩展到脚本内容） */
const SCRIPT_FILE_RE = /[^\s"'|&;,()<>]+\.(?:py|pyw|js|mjs|cjs|ts|ps1|sh|bash|zsh|rb|pl|bat|cmd|vbs)\b/i

/** 以解释器（可带路径，如 /usr/bin/python、C:\Python\python.exe）开头的命令段 */
const INTERPRETER_SEGMENT_RE =
  /^(?:[^\s"']*[\\/])?(?:python3?|py|node|nodejs|pwsh|powershell|bash|sh|zsh|deno|bun|ruby|perl|cmd)(?:\.exe|[\d.]+)?\s+([\s\S]*)$/i

/**
 * 提取命令行里"交给解释器执行"的脚本文件路径（python a.py / node b.js / pwsh -File c.ps1 / cmd /c d.bat）。
 * 调用方据此读取脚本内容继续做删除检测：否则"先用 file_write 写脚本、再执行脚本"可绕过命令文本层面的拦截。
 * 只检查以解释器开头的命令段（按 ; & | 换行切分），避免把路径片段（如 git checkout src/node/config.js）
 * 误当成待执行脚本。返回未解析、未判存在的原始 token。
 */
export function extractInvokedScriptPaths(command: string): string[] {
  const paths: string[] = []
  const scriptRe = new RegExp(`(?:^|[\\s=,("'\`])(${SCRIPT_FILE_RE.source})["']?(?=[\\s"'|&;,()<>]|$)`, 'gi')
  for (const segment of command.split(/[;&|\n]+/)) {
    const segmentMatch = INTERPRETER_SEGMENT_RE.exec(segment.trim())
    if (!segmentMatch) continue
    const args = segmentMatch[1]
    let m: RegExpExecArray | null
    scriptRe.lastIndex = 0
    while ((m = scriptRe.exec(args)) !== null) {
      if (m[1].startsWith('-')) continue // 选项（-File、--config=x.py）
      paths.push(m[1])
    }
  }
  return [...new Set(paths)]
}
