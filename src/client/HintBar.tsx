/**
 * 旁路提示 · 发送键旁的紧凑入口（浏览器半边）。
 *
 * 交互对齐 szg 的「💡 发提示」：跑任务时随时插一句，AI 下一步参考到，任务不被打断。
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
 * ## 附图（2026-10-15 增补）
 *
 * 三种入口都能附图，覆盖「用户看到问题的那一瞬间」：**粘贴**（截图后 Ctrl+V，最常用）、
 * **拖放**（把文件拖到面板上）、**点选**（隐藏的 file input）。图在本地先压（见
 * `./image-prep.ts`），再以 base64 随 POST 上行；面板里画的是本地 object URL，
 * 零往返就能看到自己附了什么。待参考列表里的缩略图走宿主的
 * `GET /dsh-szg-hint/image/<id>/<index>`（按「提示 id + 序号」取，不暴露 attachmentId）。
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
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react'
import type { HintImageLimits, HintImageRef, HintImageUpload } from '../protocol.ts'
import { prepareImage, type DraftImage } from './image-prep.ts'
import type { HintActionEvent, HintLinkState, HintWriteResult } from './link.ts'
import styles from './hint.module.css'

/**
 * 宿主快照源的**最小结构面**（本地声明）。
 *
 * 为什么不在独立仓库里 `import type` 宿主包：本包对外发布，装到别人的 dsh 上时不会带上
 * 宿主包的类型增强；跨包 import 还会把整张宿主类型图（以及它依赖的几十个包）拖进构建。
 * 组件只用到 `getSnapshot` / `subscribe` 两个成员，按结构本地声明即可，运行时完全一致。
 */
export interface HostObservable<T> {
  /** 读当前快照（渲染器据此建立 uSES 订阅）。 */
  getSnapshot(): T
  /** 订阅快照失效；返回退订函数。 */
  subscribe(fn: () => void): () => void
}

/** 渲染器把 `hooks.hintState` 绑成的选择器 Hook（`useHintState`）。 */
export type SnapshotSelectorHook<T> = <S>(sel: (s: T) => S, eq?: (a: S, b: S) => boolean) => S

/**
 * `conversation.input.right` 槽位标准 props 里本组件用到的部分 + 注入面。
 *
 * 只声明实际读到的字段：`sessionId` 来自槽位的会话域标准 props，`useHintState` 由
 * `hooks.hintState` 绑定而来，`hintSend` / `hintCancel` 是 `apply` 注入的业务回调。
 */
export type HintBarProps = {
  /** 本条带所属会话（提示默认落到这个会话）。 */
  sessionId: string
  /** 宿主链路快照（选择器 Hook）。 */
  useHintState: SnapshotSelectorHook<HintLinkState>
} & Pick<HintBarInjected, 'hintSend' | 'hintCancel'>

/** 提示入口注入给组件的业务面（`apply` 的 inject 工厂产出）。 */
export interface HintBarInjected {
  /** 宿主链路快照（裸 observable → 渲染器绑成 `useHintState`）。 */
  hooks: { hintState: HostObservable<HintLinkState> }
  /** 发一条提示（落到本条带所属的会话）；`images` 为已压好的附图。 */
  hintSend: (text: string, images: readonly HintImageUpload[]) => Promise<HintWriteResult>
  /** 撤销一条待参考的提示。 */
  hintCancel: (id: number) => Promise<HintWriteResult>
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
/** 图片类型白名单（宿主缺席时的兜底；正常情况下用快照里的限额）。 */
const FALLBACK_LIMITS: HintImageLimits = {
  enabled: false,
  maxImages: 3,
  maxImageBytes: 4 * 1024 * 1024,
  maxTotalBytes: 12 * 1024 * 1024,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

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
 * 字节数的人读文案（附图角标用）。
 * @param bytes - 字节数。
 * @returns 形如 `312 KB`。
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(Math.max(0, Math.round(bytes)))} B`
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 取该条待参考提示里某张图的地址（宿主按「提示 id + 序号」回吐字节）。
 * @param hintId - 提示 id。
 * @param index - 图序号。
 * @returns 相对 URL。
 */
function imageUrlOf(hintId: number, index: number): string {
  return `/dsh-szg-hint/image/${String(hintId)}/${String(index)}`
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
  const [drafts, setDrafts] = useState<DraftImage[]>([])
  const [busy, setBusy] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [preview, setPreview] = useState<{ url: string, caption: string } | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  /** 面板水平修正量（px）：面板右边缘锚在按钮上，窄窗时左侧会被视口切掉。 */
  const [panelShift, setPanelShift] = useState(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const draftRef = useRef<HTMLTextAreaElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const toastSeq = useRef(0)
  const seenKeys = useRef(new Set<string>())
  const lastEventSeq = useRef(0)
  const imageSeq = useRef(0)
  /** 最新一批附图（发送时用 ref 读，避免把 object URL 的清理绑在 state 上）。 */
  const draftsRef = useRef<DraftImage[]>([])
  /** 大图预览是否开着（Esc 要据此决定「关预览」还是「关面板」，用 ref 免得重挂事件）。 */
  const previewOpenRef = useRef(false)
  draftsRef.current = drafts
  previewOpenRef.current = preview !== null

  const limits = snapshot?.imageLimits ?? FALLBACK_LIMITS
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

  /**
   * 丢掉一张待发图（连带释放它的 object URL，否则每删一张就漏一份内存）。
   * @param key - 本地 key。
   */
  const dropDraft = useCallback((key: number) => {
    setDrafts(list => {
      const target = list.find(item => item.key === key)
      if (target !== undefined) URL.revokeObjectURL(target.previewUrl)
      return list.filter(item => item.key !== key)
    })
  }, [])

  /** 清空全部待发图（发送成功或关闭面板时调用）。 */
  const clearDrafts = useCallback(() => {
    for (const item of draftsRef.current) URL.revokeObjectURL(item.previewUrl)
    setDrafts([])
  }, [])

  /**
   * 把一批文件压好放进待发清单。
   * @param files - 用户粘贴 / 拖放 / 选择来的文件。
   */
  const addFiles = useCallback(async (files: readonly File[]) => {
    if (files.length === 0) return
    if (!limits.enabled) {
      pushToast('err', '❌ 当前宿主没有附件服务，暂时不能带图（纯文字提示照常可用）')
      return
    }
    const room = limits.maxImages - draftsRef.current.length
    if (room <= 0) {
      pushToast('err', `❌ 一条提示最多 ${String(limits.maxImages)} 张图，先删掉一张再加`)
      return
    }
    const accepted = files.slice(0, room)
    if (files.length > room) {
      pushToast('warn', `⚠ 一条提示最多 ${String(limits.maxImages)} 张图，多出的 ${String(files.length - room)} 张没有加进来`)
    }
    setPreparing(true)
    try {
      const added: DraftImage[] = []
      let total = draftsRef.current.reduce((sum, item) => sum + item.bytes, 0)
      for (const file of accepted) {
        imageSeq.current += 1
        // eslint-disable-next-line no-await-in-loop -- 逐张处理：canvas 编码是重活，并发会把界面卡住。
        const result = await prepareImage(file, limits, imageSeq.current)
        if (!result.ok) {
          pushToast('err', `❌ ${result.error}`)
          continue
        }
        if (limits.maxTotalBytes > 0 && total + result.image.bytes > limits.maxTotalBytes) {
          URL.revokeObjectURL(result.image.previewUrl)
          pushToast('err', `❌ 合计会超过 ${formatBytes(limits.maxTotalBytes)}，这张没有加进来`)
          continue
        }
        total += result.image.bytes
        added.push(result.image)
      }
      if (added.length > 0) {
        setDrafts(list => [...list, ...added])
        const compressed = added.filter(item => item.compressed).length
        pushToast('ok', compressed > 0
          ? `已附 ${String(added.length)} 张图（其中 ${String(compressed)} 张在本地压过）`
          : `已附 ${String(added.length)} 张图`)
      }
    } finally {
      setPreparing(false)
    }
  }, [limits, pushToast])

  // 组件卸载：把还没发出去的本地预览 URL 全部释放。
  useEffect(() => () => {
    for (const item of draftsRef.current) URL.revokeObjectURL(item.previewUrl)
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
      if (keyEvent.key !== 'Escape') return
      // 大图预览开着时，Esc 先关预览（预览是更「上层」的一次点击）。
      if (previewOpenRef.current) {
        setPreview(null)
        return
      }
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  /**
   * 面板贴着按钮的右边缘弹出；窗口窄或按钮靠左时，左侧会被裁掉。
   *
   * 注意「被谁裁」不只是视口：dsh 的会话列容器（`.frame` / `.centerCol`）是
   * `overflow: hidden`，面板一旦越出它的边界就整块消失一半——所以可用的水平区间必须是
   * **最近一个裁剪祖先**与视口的交集，只按 `window.innerWidth` 算是修不好的（实测复现）。
   * 用 transform 平移，不改布局。
   */
  useEffect(() => {
    if (!open) {
      setPanelShift(0)
      return
    }
    const measure = (): void => {
      const panel = panelRef.current
      if (panel === null) return
      const gutter = 8
      const viewportRight = window.innerWidth
      // 从面板往上找最近一个会裁剪的祖先，取其内容盒边界（没有就用视口）。
      let clipLeft = 0
      let clipRight = viewportRight
      for (let node = panel.parentElement; node !== null && node !== document.body; node = node.parentElement) {
        const style = window.getComputedStyle(node)
        if (style.overflowX === 'visible' && style.overflowY === 'visible') continue
        const box = node.getBoundingClientRect()
        clipLeft = Math.max(clipLeft, box.left)
        clipRight = Math.min(clipRight, box.right)
        break
      }
      const rect = panel.getBoundingClientRect()
      // 先按「当前没有平移」还原真实边缘（rect 已含上一轮平移量）。
      const naturalLeft = rect.left - panelShift
      const naturalRight = naturalLeft + rect.width
      let shift = 0
      if (naturalLeft < clipLeft + gutter) shift = clipLeft + gutter - naturalLeft
      else if (naturalRight > clipRight - gutter) shift = clipRight - gutter - naturalRight
      setPanelShift(Math.round(shift))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => { window.removeEventListener('resize', measure) }
  }, [open, panelShift])


  const submit = async (): Promise<void> => {
    const text = draft.trim()
    if (text.length === 0 && drafts.length === 0) return
    setBusy(true)
    const images: HintImageUpload[] = drafts.map(item => ({
      mediaType: item.mediaType,
      data: item.data,
      name: item.name,
    }))
    const result = await hintSend(text, images)
    setBusy(false)
    if (!result.ok) {
      pushToast('err', `❌ ${result.error ?? '发送失败'}`)
      return
    }
    const withImages = images.length > 0 ? `（含 ${String(images.length)} 张图）` : ''
    setDraft('')
    clearDrafts()
    setOpen(false)
    // 本地先给回执并把 `added` 键记进去重表：随后到达的 `added` 帧不会再弹一次。
    pushToast('ok', running
      ? `💡 提示已发送${withImages}，AI 将在下一步参考`
      : `💡 提示已保存${withImages}，将在下个任务开始时参考`, toastKey('added', result.hintId))
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

  /** 粘贴：从剪贴板里挑出图片（截图后 Ctrl+V 的主路径）。 */
  const onPaste = (pasteEvent: ClipboardEvent<HTMLTextAreaElement>): void => {
    const items = pasteEvent.clipboardData?.items
    if (items === undefined) return
    const files: File[] = []
    for (const item of items) {
      if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
      const file = item.getAsFile()
      if (file !== null) files.push(file)
    }
    if (files.length === 0) return
    // 只有图、没有文字时才拦下默认行为（否则用户同时粘文字+图会被吃掉文字）。
    if ((pasteEvent.clipboardData?.getData('text') ?? '').length === 0) pasteEvent.preventDefault()
    void addFiles(files)
  }

  /** 拖放：把文件拖到面板上。 */
  const onDrop = (dropEvent: DragEvent<HTMLDivElement>): void => {
    dropEvent.preventDefault()
    setDragging(false)
    const files = [...(dropEvent.dataTransfer?.files ?? [])]
    if (files.length > 0) void addFiles(files)
  }

  const title = running
    ? '给正在执行的任务加一句提示（可附图，不打断它）'
    : '写一句提示（可附图），下个任务开始时参考'
  const statusText = snapshot === null
    ? '等待宿主…'
    : running
      ? '运行中 · 下一步参考'
      : '空闲 · 下个任务参考'
  const canSend = !busy && !preparing && (draft.trim().length > 0 || drafts.length > 0)
  const attachTitle = limits.enabled
    ? `附图（最多 ${String(limits.maxImages)} 张，单张 ≤ ${formatBytes(limits.maxImageBytes)}）：可粘贴 / 拖入 / 点选`
    : '当前宿主没有附件服务，暂不支持附图'

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
        {
          className: `${styles.panel}${dragging ? ` ${styles.panelDrop}` : ''}`,
          ref: panelRef,
          style: panelShift !== 0 ? { transform: `translateX(${String(panelShift)}px)` } : undefined,
          role: 'dialog',
          'aria-label': '旁路提示',
          onDragOver: (dragEvent: DragEvent<HTMLDivElement>) => {
            if (!limits.enabled) return
            // 必须 preventDefault，否则浏览器不会派发 drop（并且会用默认行为打开文件）。
            dragEvent.preventDefault()
            setDragging(true)
          },
          onDragLeave: () => { setDragging(false) },
          onDrop,
        },
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
            ? '给正在跑的任务加一句话…（可粘贴截图；Enter 发送，Shift+Enter 换行）'
            : '写一句提示，下个任务开始时会被参考…（可粘贴截图；Enter 发送）',
          onChange: (changeEvent: ChangeEvent<HTMLTextAreaElement>) => { setDraft(changeEvent.target.value) },
          onPaste,
          onKeyDown: (keyEvent: KeyboardEvent<HTMLTextAreaElement>) => {
            if (keyEvent.key === 'Enter' && !keyEvent.shiftKey) {
              keyEvent.preventDefault()
              void submit()
            }
          },
        }),
        drafts.length > 0 || preparing
          ? createElement(
            'div',
            { className: styles.thumbs },
            drafts.map(item => createElement(
              'div',
              { key: item.key, className: styles.thumb },
              createElement('img', {
                className: styles.thumbImg,
                src: item.previewUrl,
                alt: item.name,
                title: `${item.name} · ${String(item.width)}x${String(item.height)} · ${formatBytes(item.bytes)}${item.compressed ? ' · 已压缩' : ''}`,
                onClick: () => {
                  setPreview({
                    url: item.previewUrl,
                    caption: `${item.name} · ${String(item.width)}x${String(item.height)} · ${formatBytes(item.bytes)}${item.compressed ? ' · 已压缩' : ''}`,
                  })
                },
              }),
              createElement(
                'button',
                {
                  type: 'button',
                  className: styles.thumbRemove,
                  title: '移除这张图',
                  'aria-label': `移除 ${item.name}`,
                  onClick: () => { dropDraft(item.key) },
                },
                '✕',
              ),
              item.compressed ? createElement('span', { className: styles.thumbMark }, '压') : null,
            )),
            preparing ? createElement('div', { className: `${styles.thumb} ${styles.thumbBusy}` }, '压缩中…') : null,
          )
          : null,
        createElement(
          'div',
          { className: styles.actions },
          createElement(
            'button',
            {
              type: 'button',
              className: `${styles.attach}${drafts.length > 0 ? ` ${styles.attachFilled}` : ''}`,
              disabled: !limits.enabled || drafts.length >= limits.maxImages,
              title: attachTitle,
              'aria-label': '附图',
              onClick: () => { fileRef.current?.click() },
            },
            // 图画图标用内联 SVG 而不是 `🖼` emoji：本机字体把 U+1F5BC 渲染成单色方框字形，
            // 在 13px 下发灰发糊，看起来像坏图标；SVG 走 currentColor，明暗主题与 hover 都能跟。
            // 已附张数不在这里加角标——按钮下方那句「带 N 张图」和上面的缩略图已经说明，
            // 在 28px 的按钮角上再挤一个数字只会糊成一团（实测过，像颗深绿疙瘩）。
            createElement(
              'svg',
              {
                viewBox: '0 0 16 16',
                width: 15,
                height: 15,
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: 1.15,
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
                'aria-hidden': true,
              },
              createElement('rect', { x: 2, y: 2.9, width: 12, height: 10.2, rx: 2.4 }),
              createElement('circle', { cx: 5.9, cy: 6.3, r: 1.05 }),
              createElement('path', { d: 'M2.4 11.5 5.6 8.4a1.1 1.1 0 0 1 1.55 0l1.5 1.5 1.2-1.2a1.1 1.1 0 0 1 1.56 0l2.1 2.1' }),
            ),
          ),
          createElement(
            'button',
            {
              type: 'button',
              className: styles.send,
              disabled: !canSend,
              onClick: () => { void submit() },
            },
            busy ? '发送中…' : preparing ? '压图中…' : '发送提示',
          ),
          createElement(
            'span',
            { className: styles.actionsNote },
            drafts.length > 0
              ? `带 ${String(drafts.length)} 张图 · ${running ? '不打断当前任务' : '排队等下个任务'}`
              : limits.enabled
                ? '可粘贴 / 拖入截图'
                : '纯文字（宿主无附件服务）',
          ),
        ),
        createElement('input', {
          ref: fileRef,
          className: styles.file,
          type: 'file',
          accept: limits.mediaTypes.length > 0 ? limits.mediaTypes.join(',') : 'image/*',
          multiple: true,
          'aria-hidden': true,
          tabIndex: -1,
          onChange: (changeEvent: ChangeEvent<HTMLInputElement>) => {
            const files = [...(changeEvent.target.files ?? [])]
            changeEvent.target.value = ''
            void addFiles(files)
          },
        }),
        pending.length > 0
          ? createElement(
            'div',
            { className: styles.list },
            createElement('div', { className: styles.listTitle }, `待参考 ${String(pending.length)}`),
            pending.map(item => createElement(
              'div',
              { key: item.id, className: styles.item },
              item.images.length > 0
                ? createElement(
                  'div',
                  { className: styles.itemThumbs },
                  item.images.map((image: HintImageRef, index: number) => createElement('img', {
                    key: image.attachmentId,
                    className: styles.itemThumb,
                    src: imageUrlOf(item.id, index),
                    alt: image.name ?? '附图',
                    title: `${image.name ?? '附图'} · ${String(image.width)}x${String(image.height)}`,
                    onError: (imageEvent: { currentTarget: HTMLImageElement }) => { imageEvent.currentTarget.style.display = 'none' },
                    onClick: () => {
                      setPreview({
                        url: imageUrlOf(item.id, index),
                        caption: `${image.name ?? '附图'} · ${String(image.width)}x${String(image.height)} · ${formatBytes(image.bytes)}`,
                      })
                    },
                  })),
                )
                : null,
              createElement(
                'span',
                { className: styles.itemText, title: item.content.length > 0 ? item.content : '（图片提示）' },
                item.content.length > 0 ? item.content : '（图片提示）',
              ),
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
              item.imageCount > 0
                ? createElement('span', { className: styles.itemImgMark }, `图${String(item.imageCount)}`)
                : null,
              createElement(
                'span',
                { className: styles.itemText, title: item.text },
                item.text.length > 0 ? item.text : '（图片提示）',
              ),
              createElement('span', { className: styles.itemMark }, '已参考'),
            )),
          )
          : null,
        createElement('div', { className: styles.foot }, '提示不占对话历史，AI 只在下一步看到它一次'),
      )
      : null,
    preview !== null
      ? createElement(
        'div',
        {
          className: styles.preview,
          role: 'dialog',
          'aria-label': '查看附图',
          onClick: () => { setPreview(null) },
        },
        createElement('img', { className: styles.previewImg, src: preview.url, alt: preview.caption }),
        createElement('div', { className: styles.previewCaption }, preview.caption),
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
  const withImages = event.imageCount > 0 ? `（含 ${String(event.imageCount)} 张图）` : ''
  if (event.kind === 'added') {
    pushToast('ok', running ? `💡 提示已入队${withImages}，AI 将在下一步参考` : `💡 提示已入队${withImages}，将在下个任务开始时参考`, toastKey('added', event.ids[0]))
    return
  }
  if (event.kind === 'consumed') {
    const suffix = event.text.length > 0 ? `：${event.text}` : ''
    pushToast('ok', `💡 AI 已参考你的提示${withImages}${suffix}`, toastKey('consumed', event.ids[0]))
    return
  }
  pushToast('warn', '已撤销提示', toastKey('cancelled', event.ids[0]))
}
