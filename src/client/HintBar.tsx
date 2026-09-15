/**
 * 旁路提示 · 发送键旁的紧凑入口（浏览器半边）。
 *
 * 交互语义：跑任务时随时插一句，AI 下一步参考到，任务不被打断。
 * 形态与其差异（都是 dsh 侧的设计决定）：
 *  - 入口是**紧凑图标按钮**（28px 圆，与工具行左侧 `+` 同规格），落在 `conversation.input.right`
 *    ——发送键那一排、模型选择器之前；不再是占一整行的条带（那是 `conversation.input.dock`
 *    的语义，留给排队消息与待办）。
 *  - 面板**向上弹出并右对齐**在按钮上方：输入框 + 发送、待参考列表（可撤销）、最近已参考。
 *    点面板外或按 Esc 关闭。
 *  - 入口**常驻**（szg 只在运行时显示）：空闲时发的提示会排队等下一个任务，用户需要看得见它；
 *    运行中图标点亮为品牌色，有待参考时右上角出现计数角标。
 *  - 「AI 已参考」回执来自宿主 SSE（`hint` 帧），断线时靠轮询快照兜底，刷新不丢。
 *
 * 组件只做渲染与本地交互状态：数据来自注入的 `useHintState`（link 的 observable），
 * 写操作来自注入的 `hintSend` / `hintCancel` 回调——组件自己不碰 fetch。
 *
 * @module dsh-szg-hint/client
 */

import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react'
import type { HintActionEvent, HintLinkState, HintWriteResult } from './link.ts'
import styles from './hint.module.css'

/**
 * 渲染器交给组件的裸 observable：`hooks` 隔间的每一项被绑成 `use<Name>`。
 * 本地声明，理由见 `./index.ts` 模块头（独立仓库不带宿主类型增强）。
 */
export interface HostObservable<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** 提示入口注入给组件的业务面（`apply` 的 inject 工厂产出）。 */
export interface HintBarInjected {
  /** 宿主链路快照（裸 observable → 渲染器绑成 `useHintState`）。 */
  hooks: { hintState: HostObservable<HintLinkState> }
  /** 发一条提示（落到本条带所属的会话）。 */
  hintSend: (text: string) => Promise<HintWriteResult>
  /** 撤销一条待参考的提示。 */
  hintCancel: (id: number) => Promise<HintWriteResult>
}

/** 槽位运行时 props 里本组件用到的那一份（会话域补 `sessionId`）。 */
export interface HintBarProps extends HintBarInjected {
  /** 本条带所属会话。 */
  sessionId: string
  /** 由 inject 的 `hooks.hintState` 绑成的 hook。 */
  useHintState: <T>(selector: (value: HintLinkState) => T) => T
}

/** 轻提示。 */
interface Toast {
  id: number
  tone: 'ok' | 'warn' | 'err'
  text: string
}

/** 轻提示停留时长（毫秒）。 */
const TOAST_TTL_MS = 4200
/** 轻提示同时最多堆叠几条。 */
const TOAST_STACK_MAX = 4
/** 「最近已参考」在面板里展示几条。 */
const RECENT_SHOWN = 3

/**
 * 轻提示的去重键。
 *
 * 必须带上动作：一条提示会先后经历入队 / 被参考 / 被撤销，这些是不同的回执；
 * 只用提示 id 当键会让后面的回执被去重吞掉（撤销的成功与失败回执都弹不出来，
 * 用户看不到反馈，甚至会误以为已撤销成功）。本地乐观回执与宿主 SSE 那一份
 * 必须给同一个动作同一个键，否则同一件事会弹两次。
 *
 * @param action - 回执对应的动作。
 * @param id - 提示 id。
 * @returns 去重键。
 */
function toastKey(action: 'added' | 'consumed' | 'cancelled' | 'cancelFailed', id: number): string {
  return `${action}:${String(id)}`
}

/**
 * 发送键旁的提示入口（图标按钮 + 上弹面板）。
 * @param props - 槽位标准 props（含 `sessionId`）与注入面。
 * @returns 入口元素。
 */
export function HintBar({
  sessionId, useHintState, hintSend, hintCancel,
}: HintBarProps): ReactElement {
  const link = useHintState(value => value)
  const snapshot = link.snapshot
  const event = link.event
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  const rootRef = useRef<HTMLDivElement | null>(null)
  const draftRef = useRef<HTMLTextAreaElement | null>(null)
  const toastSeq = useRef(0)
  const seenKeys = useRef(new Set<string>())
  const lastEventSeq = useRef(0)

  const running = snapshot?.runningSessions.includes(sessionId) ?? false
  const pending = useMemo(
    () => (snapshot?.pending ?? []).filter(item => item.sessionId === sessionId || item.sessionId.length === 0),
    [snapshot, sessionId],
  )
  const recent = useMemo(
    () => (snapshot?.recentConsumed ?? []).filter(item => item.sessionId === sessionId || item.sessionId.length === 0),
    [snapshot, sessionId],
  )

  /**
   * 弹一条轻提示。
   * @param tone - 语气（决定配色）。
   * @param text - 正文。
   * @param key - 去重键（`动作:id`，见 `toastKey`）：同一件事只弹一次（本地已弹过 / 刷新后 SSE 重放都算）。
   */
  const pushToast = useCallback((tone: Toast['tone'], text: string, key?: string) => {
    if (key !== undefined) {
      if (seenKeys.current.has(key)) return
      seenKeys.current.add(key)
      if (seenKeys.current.size > 500) seenKeys.current.clear()
    }
    toastSeq.current += 1
    const id = toastSeq.current
    setToasts(list => [...list, { id, tone, text }].slice(-TOAST_STACK_MAX))
    window.setTimeout(() => {
      setToasts(list => list.filter(item => item.id !== id))
    }, TOAST_TTL_MS)
  }, [])

  // 宿主动作帧 → 轻提示。只处理本会话（或全局）的事件，别的标签页发的不该在这里弹。
  useEffect(() => {
    if (event === null || event.seq === lastEventSeq.current) return
    lastEventSeq.current = event.seq
    applyHintEvent(event, sessionId, running, pushToast)
  }, [event, sessionId, running, pushToast])

  // 面板打开后：点面板外或按 Esc 关闭，并把焦点交给输入框。
  useEffect(() => {
    if (!open) return
    draftRef.current?.focus()
    const onPointerDown = (pointerEvent: PointerEvent): void => {
      const root = rootRef.current
      if (root !== null && pointerEvent.target instanceof Node && root.contains(pointerEvent.target)) return
      setOpen(false)
    }
    const onKeyDown = (keyEvent: globalThis.KeyboardEvent): void => {
      if (keyEvent.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  /** 提交一条提示。 */
  const submit = async (): Promise<void> => {
    const text = draft.trim()
    if (text.length === 0) return
    setBusy(true)
    const result = await hintSend(text)
    setBusy(false)
    if (!result.ok) {
      pushToast('err', `❌ ${result.error ?? '发送失败'}`)
      return
    }
    setDraft('')
    setOpen(false)
    // 本地先给回执并把 `added` 键记进去重表：随后到达的 `added` 帧不会再弹一次。
    pushToast('ok', running ? '💡 提示已发送，AI 将在下一步参考' : '💡 提示已保存，将在下个任务开始时参考', toastKey('added', result.hintId))
  }

  /**
   * 撤销一条提示。
   * @param id - 提示 id。
   */
  const cancel = async (id: number): Promise<void> => {
    const result = await hintCancel(id)
    if (!result.ok) {
      pushToast('err', `❌ ${result.error ?? '撤销失败'}`, toastKey('cancelFailed', id))
      return
    }
    pushToast('warn', '已撤销这条提示', toastKey('cancelled', id))
  }

  const title = running
    ? '给正在执行的任务加一句提示（不打断它）'
    : '写一句提示，下个任务开始时参考'
  const statusText = snapshot === null
    ? '等待宿主…'
    : running
      ? '运行中 · 下一步参考'
      : '空闲 · 下个任务参考'

  return createElement(
    'div',
    { className: styles.root, ref: rootRef },
    createElement(
      'button',
      {
        type: 'button',
        className: `${styles.trigger}${running ? ` ${styles.triggerLive}` : ''}${open ? ` ${styles.triggerOpen}` : ''}`,
        title,
        'aria-label': title,
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        onClick: () => { setOpen(value => !value) },
      },
      createElement(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 16,
          height: 16,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        createElement('path', { d: 'M8 1.9a4.1 4.1 0 0 0-2.42 7.41c.33.25.56.62.56 1.02v.27h3.72v-.27c0-.4.23-.77.56-1.02A4.1 4.1 0 0 0 8 1.9Z' }),
        createElement('path', { d: 'M6.4 12.3h3.2M7 13.9h2' }),
      ),
      pending.length > 0
        ? createElement('span', { className: styles.badge }, pending.length > 99 ? '99+' : String(pending.length))
        : null,
    ),
    open
      ? createElement(
        'div',
        { className: styles.panel, role: 'dialog', 'aria-label': '旁路提示' },
        createElement(
          'div',
          { className: styles.head },
          createElement('span', { className: styles.title }, '旁路提示'),
          createElement('span', { className: styles.meta }, statusText),
          createElement(
            'button',
            {
              type: 'button',
              className: styles.close,
              title: '关闭',
              'aria-label': '关闭',
              onClick: () => { setOpen(false) },
            },
            '✕',
          ),
        ),
        createElement('textarea', {
          ref: draftRef,
          className: styles.input,
          'aria-label': '提示内容',
          value: draft,
          rows: 3,
          maxLength: snapshot?.maxContentChars ?? 2000,
          placeholder: running
            ? '给正在跑的任务加一句话…（Enter 发送，Shift+Enter 换行）'
            : '写一句提示，下个任务开始时会被参考…（Enter 发送）',
          onChange: (changeEvent: ChangeEvent<HTMLTextAreaElement>) => { setDraft(changeEvent.target.value) },
          onKeyDown: (keyEvent: KeyboardEvent<HTMLTextAreaElement>) => {
            if (keyEvent.key === 'Enter' && !keyEvent.shiftKey) {
              keyEvent.preventDefault()
              void submit()
            }
          },
        }),
        createElement(
          'div',
          { className: styles.actions },
          createElement(
            'button',
            {
              type: 'button',
              className: styles.send,
              disabled: busy || draft.trim().length === 0,
              onClick: () => { void submit() },
            },
            busy ? '发送中…' : '发送提示',
          ),
          createElement('span', { className: styles.actionsNote }, running ? '不打断当前任务' : '排队等下个任务'),
        ),
        pending.length > 0
          ? createElement(
            'div',
            { className: styles.list },
            createElement('div', { className: styles.listTitle }, `待参考 ${String(pending.length)}`),
            pending.map(item => createElement(
              'div',
              { key: item.id, className: styles.item },
              createElement('span', { className: styles.itemText, title: item.content }, item.content),
              createElement(
                'button',
                { type: 'button', className: styles.itemAction, onClick: () => { void cancel(item.id) } },
                '撤销',
              ),
            )),
          )
          : createElement('div', { className: styles.empty }, '没有待参考的提示'),
        recent.length > 0
          ? createElement(
            'div',
            { className: styles.list },
            createElement('div', { className: styles.listTitle }, '最近已参考'),
            recent.slice(0, RECENT_SHOWN).map(item => createElement(
              'div',
              { key: item.id, className: `${styles.item} ${styles.itemDone}` },
              createElement('span', { className: styles.itemText, title: item.text }, item.text),
              createElement('span', { className: styles.itemMark }, '已参考'),
            )),
          )
          : null,
        createElement('div', { className: styles.foot }, '提示不占对话历史，AI 只在下一步看到它一次'),
      )
      : null,
    createElement(
      'div',
      { className: styles.toasts },
      toasts.map(toast => createElement(
        'div',
        {
          key: toast.id,
          className: `${styles.toast} ${toast.tone === 'ok' ? styles.toastOk : toast.tone === 'warn' ? styles.toastWarn : styles.toastErr}`,
        },
        createElement('span', { className: styles.toastIcon }, toast.tone === 'err' ? '⚠' : '💡'),
        createElement('span', { className: styles.toastText }, toast.text),
      )),
    ),
  )
}

/**
 * 把一帧动作事件翻译成轻提示。
 * @param event - 宿主动作帧。
 * @param sessionId - 本条带所属会话（过滤别的会话的动作）。
 * @param running - 该会话是否在跑回合（决定文案）。
 * @param pushToast - 弹提示的函数（带去重键）。
 */
function applyHintEvent(
  event: HintActionEvent,
  sessionId: string,
  running: boolean,
  pushToast: (tone: Toast['tone'], text: string, key?: string) => void,
): void {
  const mine = event.sessionId === sessionId || event.sessionId.length === 0
  if (!mine) return
  if (event.kind === 'added') {
    pushToast('ok', running ? '💡 提示已入队，AI 将在下一步参考' : '💡 提示已入队，将在下个任务开始时参考', toastKey('added', event.ids[0]))
    return
  }
  if (event.kind === 'consumed') {
    const suffix = event.text.length > 0 ? `：${event.text}` : ''
    pushToast('ok', `💡 AI 已参考你的提示${suffix}`, toastKey('consumed', event.ids[0]))
    return
  }
  pushToast('warn', '已撤销提示', toastKey('cancelled', event.ids[0]))
}
