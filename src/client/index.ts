/**
 * 旁路提示 · 浏览器半边入口。
 *
 * 只做两件事：建一条宿主链路（`./link.ts`），把 {@link HintBar} 注册进
 * `conversation.input.right`（工具行右侧的紧凑控件位，发送键那一排）。
 *
 * 为什么是 input.right：提示是「对当前这次执行说的话」，入口要贴着输入区、一眼能找到。
 * `conversation.input.dock` 是**卡片上方的整宽条带**（留给排队消息与待办），一个图标按钮占
 * 整行既浪费又不协调；官方 composer 里 `conversation.input.left/right` 才是为这类紧凑控件
 * 准备的位置，而右侧离发送键最近。
 *
 * 为什么链路建在 `apply` 而不是组件里：页面里只该有一个 EventSource 与一条轮询定时器。
 * 链路由插件 fiber 拥有（`ctx.effect` 释放），组件重挂载不会重连；组件要的数据经 inject 的
 * `hooks` 隔间进来（渲染器绑成 `useHintState`），写操作经 `hintSend` / `hintCancel` 回调。
 *
 * ★类型为什么是本地声明的：本包独立发布，装到别人的 dsh 上时**不会**带上宿主包的类型增强
 * （`declare module` 只在该包自己的程序里有效）。注册契约只用到这里列出的少数成员，因此按
 * 结构本地声明；跨包 `import type` 在独立仓库里无法解析，会让构建直接失败。
 *
 * @module dsh-szg-hint/client
 */

import type { Context } from '@deepseek-ai/cordis'
import { HintBar, type HintBarInjected } from './HintBar.tsx'
import { createHintLink } from './link.ts'

/** Cordis 插件名（loader 诊断用），与包名一致。 */
export const name = 'dsh-szg-hint'

/** 客户端模块表依赖：槽位服务由 `@deepseek-ai/dsh-client-ui-slots` 提供。 */
export const inject = ['slots']

/** 槽位服务的最小结构面（本地声明，见模块头注释）。 */
interface SlotsService {
  /**
   * 等某个槽键被声明后再注册；未声明时不注册，声明出现后自动补上。
   * @param key - 槽键。
   * @param register - 声明出现时调用的注册动作。
   */
  inject(key: string, register: () => unknown): void
  /**
   * 注册一个槽位贡献。
   * @param declaration - 槽键 / id / order / 展示名 / 注入工厂。
   * @param component - 该槽位的组件。
   * @returns 释放句柄。
   */
  register(declaration: Record<string, unknown>, component: unknown): unknown
}

/**
 * 注册工具行右侧的提示入口。
 * @param ctx - 客户端插件上下文。
 */
export function apply(ctx: Context): void {
  const slots = ctx.get('slots') as SlotsService | undefined
  if (slots === undefined) return
  const link = createHintLink()
  ctx.effect(() => () => link.dispose(), 'dsh-szg-hint:host link')
  slots.inject('conversation.input.right', () => slots.register(
    {
      name: 'conversation.input.right',
      id: 'dsh-szg-hint',
      order: 20,
      label: '旁路提示',
      inject: (sessionId: string): HintBarInjected => ({
        hooks: { hintState: link.state },
        hintSend: (text: string) => link.send(text, sessionId),
        hintCancel: (id: number) => link.cancel(id),
      }),
    },
    HintBar,
  ))
}
