import type { ToolDefinition } from './types'
import SkillExecEnvService from '../../skill-exec-env.service'
import SkillRegistryService from '../../skill-registry.service'

// run_skill_script 工具：执行 skill 的 scripts/ 目录下的脚本
// - 受全局开关 skills_enable_script_execution 控制（在 employee-agent.service.ts 注册时判断）
// - 受 skill 的 allowed-tools 白名单控制（handler 内校验）
export const runSkillScriptTool: ToolDefinition = {
  id: 'run_skill_script',
  name: 'run_skill_script',
  title: '运行 Skill 脚本',
  summary: 'Run a script from a skill\'s scripts/ directory (.py/.sh/.js); the skill must explicitly allow it.',
  description:
    'Run a script from the scripts/ directory of the specified skill. Allowed only when the skill\'s frontmatter allowed-tools includes run_skill_script. Supports .py (python), .sh (bash/sh), and .js/.mjs (node).',
  parameters: {
    type: 'object',
    properties: {
      skill_id: {
        type: 'string',
        description: 'Target skill id',
      },
      script_name: {
        type: 'string',
        description: 'Script file name only (e.g. deploy.py); must not contain a path',
      },
      args: {
        type: 'string',
        description: 'Optional arguments passed to the script, space-separated',
      },
    },
    required: ['skill_id', 'script_name'],
  },
  handler: async (args: Record<string, any>) => {
    const skillId = String(args?.skill_id || '')
    const scriptName = String(args?.script_name || '')
    const argsStr = String(args?.args || '')
    const scriptArgs = argsStr ? argsStr.split(/\s+/).filter(Boolean) : []

    if (!skillId || !scriptName) {
      return { success: false, error: 'skill_id 和 script_name 为必填参数' }
    }

    const skillRegistry = SkillRegistryService.getInstance()
    const skill = skillRegistry.getSkillById(skillId)
    if (!skill) {
      return { success: false, error: `Skill ${skillId} 不存在（项目级 skill 脚本执行暂不支持）` }
    }

    // 校验 skill 的 allowed-tools 白名单
    const allowed = (skill.allowedTools || []).some((t) => t.trim() === 'run_skill_script')
    if (!allowed) {
      return {
        success: false,
        error: `Skill "${skill.name}" 未授权运行脚本（需在 SKILL.md frontmatter 的 allowed-tools 中包含 run_skill_script）`,
      }
    }

    const execEnv = SkillExecEnvService.getInstance()
    const result = await execEnv.executeScript(skillId, scriptName, scriptArgs)

    const output: string[] = []
    if (result.stdout) output.push(`[stdout]\n${result.stdout}`)
    if (result.stderr) output.push(`[stderr]\n${result.stderr}`)
    output.push(`[exitCode: ${result.exitCode}, duration: ${result.durationMs}ms]`)

    return {
      success: result.success,
      output: output.join('\n\n'),
      error: result.success ? undefined : (result.stderr || '脚本执行失败'),
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    }
  },
  source: 'builtin',
  permission: 'dangerous',
  timeoutMs: 60000,
}
