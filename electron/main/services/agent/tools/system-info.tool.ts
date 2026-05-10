import type { ToolDefinition } from '../tool.types'
import * as os from 'os'
import { execSync } from 'child_process'
import { formatBytes } from './utils'

const IS_WINDOWS = process.platform === 'win32'

export const systemInfoTool: ToolDefinition = {
  id: 'system_info',
  name: 'system_info',
  title: '系统信息',
  description: '获取当前操作系统的基本信息，包括平台、CPU、内存、磁盘等。',
  parameters: {
    type: 'object',
    properties: {
      detail: {
        type: 'string',
        enum: ['basic', 'cpu', 'memory', 'disk', 'network', 'all'],
        description: '信息详细程度：basic基础信息、cpu处理器、memory内存、disk磁盘、network网络、all全部'
      }
    },
    required: ['detail']
  },
  handler: (args: any) => {
    try {
      const detail = args.detail || 'basic'
      const result: Record<string, any> = {}

      if (detail === 'basic' || detail === 'all') {
        result.platform = process.platform
        result.arch = process.arch
        result.hostname = os.hostname()
        result.userInfo = os.userInfo().username
        result.nodeVersion = process.version
        result.cwd = process.cwd()
        result.uptime = `${Math.floor(os.uptime() / 3600)}小时`
      }

      if (detail === 'cpu' || detail === 'all') {
        result.cpus = os.cpus().map(c => `${c.model} @ ${c.speed}MHz`)
        result.cpuCount = os.cpus().length
      }

      if (detail === 'memory' || detail === 'all') {
        const total = os.totalmem()
        const free = os.freemem()
        result.memory = {
          total: formatBytes(total),
          free: formatBytes(free),
          used: formatBytes(total - free),
          usagePercent: `${((total - free) / total * 100).toFixed(1)}%`
        }
      }

      if (detail === 'disk' || detail === 'all') {
        try {
          const drives: any[] = []
          if (IS_WINDOWS) {
            const stdout = execSync('wmic logicaldisk get DeviceID,Size,FreeSpace /format:csv', { encoding: 'utf-8', windowsHide: true })
            const lines = stdout.trim().split('\n').slice(1)
            for (const line of lines) {
              const parts = line.trim().split(',')
              if (parts.length >= 4 && parts[1]) {
                const size = parseInt(parts[2]) || 0
                const free = parseInt(parts[3]) || 0
                drives.push({ drive: parts[1], total: formatBytes(size), free: formatBytes(free), used: formatBytes(size - free) })
              }
            }
          } else {
            const stdout = execSync('df -h /', { encoding: 'utf-8' })
            drives.push({ info: stdout.trim() })
          }
          result.disks = drives
        } catch (e: any) {
          result.diskError = e.message
        }
      }

      if (detail === 'network' || detail === 'all') {
        const interfaces = os.networkInterfaces()
        result.network = Object.entries(interfaces).map(([name, addrs]) => ({
          name,
          addresses: (addrs || []).map(a => ({ family: a.family, address: a.address, internal: a.internal }))
        }))
      }

      return { success: true, output: JSON.stringify(result, null, 2) }
    } catch (error: any) {
      return { success: false, error: `获取系统信息失败: ${error.message || error}` }
    }
  },
  source: 'builtin'
}