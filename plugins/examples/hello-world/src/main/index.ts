import type { PluginContext } from '@workavatar/plugin-sdk'

let count = 0

export function activate(ctx: PluginContext): void {
  ctx.services.logger.info('hello-world 插件激活')

  // IPC：greet 通道（manifest.ipc 白名单内）
  ctx.ipc.handle('greet', (payload: unknown) => {
    const name = (payload as { name?: string })?.name ?? 'World'
    return { message: `Hello, ${name}!` }
  })

  // IPC：count 通道，演示插件私有状态
  ctx.ipc.handle('count', () => {
    count += 1
    // 发布事件（需 capabilities.events.publish），供其他插件/宿主订阅
    ctx.services.events?.publish('count-changed', { count })
    return { count }
  })

  // 注册一个命令（可被斜杠菜单/宿主调用）
  ctx.contributions.registerCommand({
    id: 'hello',
    title: 'helloWorld.command',
    handler: () => ({ message: 'Hello from command!' }),
  })
}

export function deactivate(): void {
  // 释放资源（本示例无定时器/窗口/DB 连接）
}
