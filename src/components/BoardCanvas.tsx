import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'
import { nanoid } from 'nanoid'
import {
  elementInRect,
  handlePositions,
  hitTest,
  localBounds,
  strokeIntersects,
  toLocal,
  unionBounds,
  HANDLE_CURSOR,
  HANDLE_ORDER,
  type HandleId,
  type Rect,
} from '../model/geometry'
import { isBrushTool, isShapeTool, type ToolSettings } from '../model/tools'
import {
  BoardRenderer,
  screenToWorld,
  TEXT_LINE_HEIGHT,
  worldToScreen,
  wrapText,
  type Camera,
  type RemoteCursor,
  type Theme,
} from '../render/renderer'
import { moveElements, resizeElements, rotateElements, snapshotFields, type Patch } from '../input/transform'
import { erasePartOfStroke } from '../input/erase'
import { makeImageElement, prepareImage } from '../input/media'
import { FORCE_TOUCH_SUPPORTED, trackForceTouch } from '../input/forceTouch'
import type { Session } from '../net/session'
import type { BoardElement, LiveStroke, Op, ShapeElement, ShapeKind, TextElement } from '../model/types'
import { BOARD_H, BOARD_W } from '../model/types'
import { pageIndexAt, pageTop, ribbonHeight, visiblePageIndex } from '../model/ribbon'
import { t, useLang } from '../i18n'

const isEditingField = (target: EventTarget | null): boolean => {
  const node = target as HTMLElement | null
  return !!node && /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName)
}

/** Panels floating over the canvas: excluded from the area a sheet is fitted into. */
const fitInsets = () => {
  const narrow = window.innerWidth <= 860
  return { left: narrow ? 224 : 256, right: 16, top: 16, bottom: 72 }
}

const MIN_ZOOM = 0.08
const MAX_ZOOM = 12
/** Smallest pointer move, in board units, that adds a point to a stroke. */
const POINT_EPS = 0.7
const LIVE_INTERVAL = 55

type Action =
  | { kind: 'pan'; sx: number; sy: number; cam: Camera }
  | {
      kind: 'draw'
      id: string
      style: Omit<LiveStroke, 'id' | 'pageId' | 'points'>
      points: number[]
      sentUpTo: number
      lastSent: number
      /** Pressure comes from the Force Touch trackpad rather than PointerEvent. */
      useForce: boolean
    }
  | { kind: 'shape'; el: ShapeElement; ox: number; oy: number }
  | {
      kind: 'erase'
      /** Sheet the eraser is currently on: the ribbon is long and it may cross over. */
      pageId: string
      lx: number
      ly: number
      /** Removed whole, together with their place in the z-order. */
      removed: BoardElement[]
      indices: number[]
      /** Cut strokes: their points as they were when erasing started. */
      cut: Map<string, number[]>
      /** Pieces that split off during a cut. */
      added: string[]
    }
  | { kind: 'move'; ox: number; oy: number; els: BoardElement[]; before: Map<string, Patch>; lastSent: number }
  | {
      kind: 'resize'
      handle: HandleId
      ox: number
      oy: number
      els: BoardElement[]
      bounds: Rect
      rotation: number
      before: Map<string, Patch>
      lastSent: number
    }
  | { kind: 'rotate'; cx: number; cy: number; start: number; applied: number; els: BoardElement[]; before: Map<string, Patch>; lastSent: number }
  | { kind: 'marquee'; ox: number; oy: number; additive: boolean; base: string[] }

interface TextEditorState {
  id: string
  isNew: boolean
  value: string
}

export interface BoardCanvasHandle {
  zoomBy(factor: number, cx?: number, cy?: number): void
  fit(): void
  resetZoom(): void
  getCamera(): Camera
  editText(id: string): void
  /** Opens the file picker and inserts an image into the middle of the view. */
  pickImage(): void
  /** Scrolls the ribbon to a given sheet. */
  scrollToPage(pageId: string): void
}

interface Props {
  session: Session
  tools: ToolSettings
  theme: Theme
  selection: string[]
  onSelectionChange: Dispatch<SetStateAction<string[]>>
  onZoomChange: (zoom: number) => void
  /** Ask for the select tool so a freshly inserted object can be moved at once. */
  onRequestSelect: () => void
  /** Which sheet is in view — the pages bar and export follow it. */
  onActivePageChange: (pageId: string) => void
}

export const BoardCanvas = forwardRef<BoardCanvasHandle, Props>(function BoardCanvas(
  { session, tools, theme, selection, onSelectionChange, onZoomChange, onRequestSelect, onActivePageChange },
  ref,
) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<BoardRenderer | null>(null)
  const camRef = useRef<Camera>({ x: 0, y: 0, zoom: 1 })
  const actionRef = useRef<Action | null>(null)
  const draftRef = useRef<ShapeElement | null>(null)
  const localLiveRef = useRef<LiveStroke | null>(null)
  const marqueeRef = useRef<Rect | null>(null)
  const eraserRef = useRef<{ x: number; y: number; r: number } | null>(null)
  const pointersRef = useRef(new Map<number, { x: number; y: number; type: string }>())
  const pinchRef = useRef<{ dist: number; cx: number; cy: number } | null>(null)
  const spaceRef = useRef(false)
  /** Latest trackpad force (Force Touch), already mapped to 0…1. */
  const forceRef = useRef(0.5)
  const dirtyRef = useRef(true)
  const sizeRef = useRef({ w: 0, h: 0 })

  // Fresh values for handlers that are attached only once.
  const toolsRef = useRef(tools)
  const selectionRef = useRef(selection)
  /** Page the current input belongs to, plus its offset within the ribbon. */
  const pageRef = useRef('')
  const pageTopRef = useRef(0)
  /** Sheet currently in view. */
  const viewPageRef = useRef('')
  const themeRef = useRef(theme)
  const activePageCb = useRef(onActivePageChange)
  activePageCb.current = onActivePageChange
  toolsRef.current = tools
  selectionRef.current = selection
  themeRef.current = theme

  useLang()
  const [editor, setEditor] = useState<TextEditorState | null>(null)
  const [cursorStyle, setCursorStyle] = useState('crosshair')
  const [notice, setNotice] = useState<string | null>(null)
  const [dropping, setDropping] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  /** Last pointer position in page coordinates — where pasted content lands. */
  const lastPointRef = useRef<{ x: number; y: number; pageId: string } | null>(null)

  const topOfPage = useCallback(
    (pid: string): number => {
      const i = session.store.doc.pages.findIndex((p) => p.id === pid)
      return pageTop(Math.max(0, i))
    },
    [session],
  )

  /** Remembers which sheet the input is on; all coordinates then belong to it. */
  const resolvePage = useCallback(
    (ribbonY: number) => {
      const pages = session.store.doc.pages
      if (!pages.length) return
      const index = pageIndexAt(pages.length, ribbonY)
      pageRef.current = pages[index].id
      pageTopRef.current = pageTop(index)
    },
    [session],
  )

  const invalidate = useCallback(() => {
    rendererRef.current?.invalidate()
    dirtyRef.current = true
  }, [])

  const markDirty = useCallback(() => {
    dirtyRef.current = true
  }, [])

  /* ---------------- camera ---------------- */

  const clampCamera = useCallback(() => {
    const cam = camRef.current
    cam.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.zoom))
    const { w, h } = sizeRef.current
    const viewW = w / cam.zoom
    const viewH = h / cam.zoom
    const marginX = Math.max(viewW * 0.5, 200)
    const marginY = Math.max(viewH * 0.5, 200)
    const total = ribbonHeight(session.store.doc.pages.length)
    cam.x = Math.min(BOARD_W + marginX - viewW, Math.max(-marginX, cam.x))
    cam.y = Math.min(total + marginY - viewH, Math.max(-marginY, cam.y))
  }, [session])

  const fit = useCallback(() => {
    const { w, h } = sizeRef.current
    if (!w || !h) return
    const ins = fitInsets()
    const availW = Math.max(120, w - ins.left - ins.right)
    const availH = Math.max(120, h - ins.top - ins.bottom)
    const zoom = Math.min(availW / BOARD_W, availH / BOARD_H)
    // Center the sheet in the free area rather than in the whole canvas.
    const cx = ins.left + availW / 2
    const cy = ins.top + availH / 2
    const top = topOfPage(viewPageRef.current || session.store.doc.pages[0]?.id || '')
    camRef.current = {
      zoom,
      x: BOARD_W / 2 - cx / zoom,
      y: top + BOARD_H / 2 - cy / zoom,
    }
    clampCamera()
    onZoomChange(camRef.current.zoom)
    invalidate()
  }, [clampCamera, invalidate, onZoomChange, session, topOfPage])

  /** Brings the top of a sheet to the top of the free area. */
  const scrollToPage = useCallback(
    (pid: string) => {
      const cam = camRef.current
      const ins = fitInsets()
      cam.y = topOfPage(pid) - (ins.top + 12) / cam.zoom
      clampCamera()
      invalidate()
    },
    [clampCamera, invalidate, topOfPage],
  )

  const zoomAt = useCallback(
    (factor: number, sx: number, sy: number) => {
      const cam = camRef.current
      const [wx, wy] = screenToWorld(cam, sx, sy)
      cam.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.zoom * factor))
      cam.x = wx - sx / cam.zoom
      cam.y = wy - sy / cam.zoom
      clampCamera()
      onZoomChange(cam.zoom)
      invalidate()
    },
    [clampCamera, invalidate, onZoomChange],
  )

  useImperativeHandle(
    ref,
    () => ({
      zoomBy: (factor, cx, cy) =>
        zoomAt(factor, cx ?? sizeRef.current.w / 2, cy ?? sizeRef.current.h / 2),
      fit,
      resetZoom: () => {
        const { w, h } = sizeRef.current
        const cam = camRef.current
        const [wx, wy] = screenToWorld(cam, w / 2, h / 2)
        cam.zoom = 1
        cam.x = wx - w / 2
        cam.y = wy - h / 2
        clampCamera()
        onZoomChange(cam.zoom)
        invalidate()
      },
      getCamera: () => ({ ...camRef.current }),
      editText: (id) => {
        const el = session.store.element(id)
        if (el?.type === 'text') setEditor({ id, isNew: false, value: el.text })
      },
      pickImage: () => fileInputRef.current?.click(),
      scrollToPage,
    }),
    [clampCamera, fit, invalidate, onZoomChange, scrollToPage, session, zoomAt],
  )

  /* ---------------- setup and render loop ---------------- */

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const renderer = new BoardRenderer(canvas)
    rendererRef.current = renderer

    const ro = new ResizeObserver(() => {
      const rect = wrap.getBoundingClientRect()
      const first = sizeRef.current.w === 0
      sizeRef.current = { w: rect.width, h: rect.height }
      renderer.resize(rect.width, rect.height, Math.min(window.devicePixelRatio || 1, 2.5))
      if (first) fit()
      else {
        clampCamera()
        invalidate()
      }
    })
    ro.observe(wrap)

    const unsubscribe = session.store.subscribe(invalidate)
    const unsubscribeSession = session.subscribe(markDirty)
    const unsubscribeForce = trackForceTouch(canvas, (pressure) => {
      forceRef.current = pressure
    })

    let raf = 0
    const loop = () => {
      raf = requestAnimationFrame(loop)
      if (document.hidden) return
      const hasLive = session.remoteLive.size > 0 || session.cursors.size > 0
      if (!dirtyRef.current && !hasLive) return
      dirtyRef.current = false

      const now = performance.now()
      const cursors: RemoteCursor[] = []
      for (const c of session.cursors.values()) {
        if (now - c.at > 8000) continue
        const peer = session.peer(c.id)
        cursors.push({
          id: c.id,
          name: peer?.name ?? '…',
          color: peer?.color ?? '#64748b',
          pageId: c.pageId,
          x: c.x,
          y: c.y,
          drawing: c.drawing,
        })
      }

      // Which sheet is in view — the pages bar and export follow it.
      const pages = session.store.doc.pages
      if (pages.length) {
        const cam = camRef.current
        const index = visiblePageIndex(
          pages.length,
          cam.y,
          sizeRef.current.h / cam.zoom,
        )
        const seen = pages[index].id
        if (seen !== viewPageRef.current) {
          viewPageRef.current = seen
          if (!pageRef.current) {
            pageRef.current = seen
            pageTopRef.current = pageTop(index)
          }
          activePageCb.current(seen)
        }
      }

      const liveStrokes: LiveStroke[] = [...session.remoteLive.values()]
      if (localLiveRef.current) liveStrokes.push(localLiveRef.current)

      renderer.render({
        doc: session.store.doc,
        paper: session.settings.paper,
        pageId: pageRef.current,
        camera: camRef.current,
        theme: themeRef.current,
        docVersion: session.store.version,
        liveStrokes,
        draftShape: draftRef.current,
        selection: selectionRef.current,
        marquee: marqueeRef.current,
        cursors,
        eraser: eraserRef.current,
        readOnly: !session.canDraw,
      })
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      unsubscribe()
      unsubscribeSession()
      unsubscribeForce()
      rendererRef.current = null
    }
  }, [clampCamera, fit, invalidate, markDirty, session])

  useEffect(invalidate, [invalidate, theme])

  /* ---------------- helpers ---------------- */

  /** Point in ribbon coordinates. */
  const toRibbon = useCallback((e: { clientX: number; clientY: number }): [number, number] => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return screenToWorld(camRef.current, e.clientX - rect.left, e.clientY - rect.top)
  }, [])

  /**
   * Point in the current sheet's coordinates. Everything downstream — drawing,
   * selection, erasing — then works within a single page, as it always did.
   */
  const toWorld = useCallback(
    (e: { clientX: number; clientY: number }): [number, number] => {
      const [x, y] = toRibbon(e)
      return [x, y - pageTopRef.current]
    },
    [toRibbon],
  )

  const toScreen = useCallback((e: { clientX: number; clientY: number }): [number, number] => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return [e.clientX - rect.left, e.clientY - rect.top]
  }, [])

  const pickElement = useCallback(
    (wx: number, wy: number): BoardElement | null => {
      const tol = 8 / camRef.current.zoom
      const els = session.store.elementsOf(pageRef.current)
      for (let i = els.length - 1; i >= 0; i--) {
        if (hitTest(els[i], wx, wy, tol)) return els[i]
      }
      return null
    },
    [session],
  )

  const selectionBox = useCallback((): { box: Rect; rotation: number; els: BoardElement[] } | null => {
    const els = selectionRef.current
      .map((id) => session.store.element(id))
      .filter(Boolean) as BoardElement[]
    if (!els.length) return null
    if (els.length === 1) {
      const el = els[0]
      return {
        box: localBounds(el),
        rotation: el.type === 'stroke' ? 0 : el.rotation,
        els,
      }
    }
    const box = unionBounds(els)
    return box ? { box, rotation: 0, els } : null
  }, [session])

  const pickHandle = useCallback(
    (sx: number, sy: number): HandleId | null => {
      const sel = selectionBox()
      if (!sel || !session.canDraw) return null
      const pos = handlePositions(sel.box, sel.rotation)
      const top = topOfPage(sel.els[0].pageId)
      const ids: HandleId[] = [...HANDLE_ORDER, 'rotate']
      for (const id of ids) {
        const [hx, hy] = worldToScreen(camRef.current, pos[id][0], pos[id][1] + top)
        if (Math.hypot(sx - hx, sy - hy) <= 10) return id
      }
      return null
    },
    [selectionBox, session, topOfPage],
  )

  /* ---------------- creating elements ---------------- */

  const makeShape = useCallback(
    (shape: ShapeKind, x: number, y: number): ShapeElement => ({
      id: nanoid(10),
      type: 'shape',
      pageId: pageRef.current,
      authorId: session.selfId,
      createdAt: Date.now(),
      shape,
      x,
      y,
      w: 0,
      h: 0,
      rotation: 0,
      color: toolsRef.current.shape.color,
      fill: toolsRef.current.shape.fill,
      size: toolsRef.current.shape.size,
      opacity: toolsRef.current.shape.opacity,
    }),
    [session],
  )

  const createText = useCallback(
    (wx: number, wy: number) => {
      const cfg = toolsRef.current.text
      const el: TextElement = {
        id: nanoid(10),
        type: 'text',
        pageId: pageRef.current,
        authorId: session.selfId,
        createdAt: Date.now(),
        x: wx,
        y: wy,
        // A new text block spans the width up to the right margin of the sheet.
        w: Math.max(120, Math.min(BOARD_W * 0.72, BOARD_W - wx - 20)),
        h: cfg.fontSize * 1.3,
        rotation: 0,
        text: '',
        color: cfg.color,
        fontSize: cfg.fontSize,
        opacity: 1,
      }
      session.store.commit({ t: 'add', el })
      onSelectionChange([el.id])
      setEditor({ id: el.id, isNew: true, value: '' })
    },
    [onSelectionChange, session],
  )

  /* ---------------- inserting objects ---------------- */

  const viewCenter = useCallback((): { x: number; y: number; pageId: string } => {
    const { w, h } = sizeRef.current
    const ins = fitInsets()
    const [x, ribbonY] = screenToWorld(
      camRef.current,
      ins.left + (w - ins.left - ins.right) / 2,
      ins.top + (h - ins.top - ins.bottom) / 2,
    )
    const pages = session.store.doc.pages
    const index = pageIndexAt(pages.length, ribbonY)
    return { x, y: ribbonY - pageTop(index), pageId: pages[index]?.id ?? '' }
  }, [session])

  /** A ribbon point together with the sheet it landed on. */
  const pointOnPage = useCallback(
    (e: { clientX: number; clientY: number }): { x: number; y: number; pageId: string } => {
      const [x, ribbonY] = toRibbon(e)
      const pages = session.store.doc.pages
      const index = pageIndexAt(pages.length, ribbonY)
      return { x, y: ribbonY - pageTop(index), pageId: pages[index]?.id ?? '' }
    },
    [session, toRibbon],
  )

  const say = useCallback((text: string) => {
    setNotice(text)
    window.setTimeout(() => setNotice((n) => (n === text ? null : n)), 4000)
  }, [])

  const insertImages = useCallback(
    async (files: File[], at?: { x: number; y: number; pageId: string }) => {
      if (!session.canDraw) return say(t('notice.cannotDraw'))
      const images = files.filter((f) => f.type.startsWith('image/'))
      if (!images.length) return
      const center = at ?? viewCenter()
      const added: string[] = []
      for (const [i, file] of images.entries()) {
        try {
          const prepared = await prepareImage(file)
          const el = makeImageElement(
            prepared,
            center.pageId,
            session.selfId,
            { x: center.x + i * 18, y: center.y + i * 18 },
            file.name,
          )
          session.store.commit({ t: 'add', el })
          added.push(el.id)
        } catch (err) {
          say((err as Error).message || t('notice.imageFailed'))
        }
      }
      if (added.length) {
        onSelectionChange(added)
        selectionRef.current = added
        onRequestSelect()
      }
    },
    [onRequestSelect, onSelectionChange, say, session, viewCenter],
  )

  const insertText = useCallback(
    (text: string, at?: { x: number; y: number; pageId: string }) => {
      if (!session.canDraw) return say(t('notice.cannotDraw'))
      const value = text.replace(/\r\n/g, '\n').trim()
      if (!value) return
      const cfg = toolsRef.current.text
      const center = at ?? viewCenter()
      const w = Math.min(BOARD_W * 0.72, BOARD_W - 40)
      const measure = document.createElement('canvas').getContext('2d')!
      measure.font = `${cfg.fontSize}px "Inter", "Segoe UI", system-ui, sans-serif`
      const lines = wrapText(measure, value, w).length
      const h = Math.max(cfg.fontSize * 1.3, lines * cfg.fontSize * TEXT_LINE_HEIGHT)
      const el: TextElement = {
        id: nanoid(10),
        type: 'text',
        pageId: center.pageId,
        authorId: session.selfId,
        createdAt: Date.now(),
        x: Math.max(0, Math.min(BOARD_W - w, center.x - w / 2)),
        y: Math.max(0, Math.min(BOARD_H - h, center.y - h / 2)),
        w,
        h,
        rotation: 0,
        text: value,
        color: cfg.color,
        fontSize: cfg.fontSize,
        opacity: 1,
      }
      session.store.commit({ t: 'add', el })
      onSelectionChange([el.id])
      selectionRef.current = [el.id]
      onRequestSelect()
    },
    [onRequestSelect, onSelectionChange, say, session, viewCenter],
  )

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (editor || isEditingField(e.target)) return
      const items = [...(e.clipboardData?.items ?? [])]
      const files = items
        .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
        .map((it) => it.getAsFile())
        .filter((f): f is File => !!f)
      if (files.length) {
        e.preventDefault()
        void insertImages(files, lastPointRef.current ?? undefined)
        return
      }
      const text = e.clipboardData?.getData('text/plain')
      if (text?.trim()) {
        e.preventDefault()
        insertText(text, lastPointRef.current ?? undefined)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [editor, insertImages, insertText])

  /* ---------------- pointer handling ---------------- */

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const finishDrag = (action: Extract<Action, { before: Map<string, Patch> }>) => {
      const undo: Op[] = []
      const redo: Op[] = []
      for (const [id, before] of action.before) {
        const el = session.store.element(id)
        if (!el) continue
        const after: Patch = {}
        for (const k of Object.keys(before)) {
          const v = (el as unknown as Record<string, unknown>)[k]
          after[k] = Array.isArray(v) ? [...v] : v
        }
        undo.push({ t: 'update', id, patch: before })
        redo.push({ t: 'update', id, patch: after })
        session.store.applyLocal({ t: 'update', id, patch: after })
      }
      session.store.pushHistory(undo, redo)
    }

    const applyPatches = (patches: Map<string, Patch>, send: boolean) => {
      for (const [id, patch] of patches) {
        session.store.applyLocal({ t: 'update', id, patch }, send)
      }
    }

    const beginGestureCleanup = () => {
      actionRef.current = null
      draftRef.current = null
      localLiveRef.current = null
      marqueeRef.current = null
      dirtyRef.current = true
    }

    /* --- press --- */
    const onPointerDown = (e: PointerEvent) => {
      if (editor) return
      const pointers = pointersRef.current
      const [sx, sy] = toScreen(e)
      pointers.set(e.pointerId, { x: sx, y: sy, type: e.pointerType })

      // Palm and fingers are ignored while the pen is in use.
      const penActive = [...pointers.values()].some((p) => p.type === 'pen')
      if (e.pointerType === 'touch' && penActive) return

      const touches = [...pointers.values()].filter((p) => p.type === 'touch')
      if (touches.length >= 2) {
        // A two-finger gesture started, so cancel whatever was being drawn.
        if (actionRef.current?.kind === 'draw' && localLiveRef.current) {
          session.sendLive(localLiveRef.current.id, pageRef.current, [], undefined, true)
        }
        beginGestureCleanup()
        const [a, b] = touches
        pinchRef.current = {
          dist: Math.hypot(a.x - b.x, a.y - b.y),
          cx: (a.x + b.x) / 2,
          cy: (a.y + b.y) / 2,
        }
        return
      }

      try {
        canvas.setPointerCapture(e.pointerId)
      } catch {
        // The pointer may already be released; handle the gesture anyway.
      }
      // The sheet under the pointer becomes the current one: the whole gesture
      // then runs in its coordinates, so a stroke cannot start on one sheet and
      // spill onto the next.
      resolvePage(toRibbon(e)[1])
      const [wx, wy] = toWorld(e)
      const cfg = toolsRef.current
      const middle = e.button === 1
      const panMode =
        middle ||
        spaceRef.current ||
        cfg.tool === 'pan' ||
        cfg.tool === 'paper' ||
        (e.pointerType === 'touch' && !cfg.fingerDraw)

      if (panMode) {
        actionRef.current = { kind: 'pan', sx, sy, cam: { ...camRef.current } }
        setCursorStyle('grabbing')
        return
      }

      if (e.button !== 0 && e.button !== 5) return

      // Eraser on the back end of a Wacom stylus.
      const penEraser = e.pointerType === 'pen' && (e.buttons & 32) !== 0
      const tool = penEraser ? 'eraser' : cfg.tool

      if (!session.canDraw && tool !== 'select') return

      // Ink only goes on paper. A click in the gap between sheets or in the
      // margins would otherwise leave ink outside the page: it gets clipped
      // while drawing and nothing shows up on the board.
      const onPaper = wx >= 0 && wx <= BOARD_W && wy >= 0 && wy <= BOARD_H
      if (!onPaper && (isBrushTool(tool) || isShapeTool(tool) || tool === 'text')) return

      if (tool === 'select') {
        const handle = pickHandle(sx, sy)
        const sel = selectionBox()
        if (handle && sel) {
          const allowed = sel.els.filter((el) => session.canEditElement(el.authorId))
          if (!allowed.length) return
          const before = new Map<string, Patch>()
          if (handle === 'rotate') {
            const cx = sel.box.x + sel.box.w / 2
            const cy = sel.box.y + sel.box.h / 2
            for (const el of allowed) {
              before.set(
                el.id,
                el.type === 'stroke'
                  ? snapshotFields(el, { points: [] })
                  : snapshotFields(el, { x: 0, y: 0, rotation: 0 }),
              )
            }
            actionRef.current = {
              kind: 'rotate',
              cx,
              cy,
              start: Math.atan2(wy - cy, wx - cx),
              applied: 0,
              els: allowed,
              before,
              lastSent: 0,
            }
          } else {
            const [lx, ly] = sel.els.length === 1 ? toLocal(sel.els[0], wx, wy) : [wx, wy]
            for (const el of allowed) {
              before.set(
                el.id,
                el.type === 'stroke'
                  ? snapshotFields(el, { points: [], size: 0 })
                  : el.type === 'text'
                    ? snapshotFields(el, { x: 0, y: 0, w: 0, h: 0, fontSize: 0 })
                    : snapshotFields(el, { x: 0, y: 0, w: 0, h: 0, size: 0 }),
              )
            }
            actionRef.current = {
              kind: 'resize',
              handle,
              ox: lx,
              oy: ly,
              els: allowed,
              bounds: sel.box,
              rotation: sel.rotation,
              before,
              lastSent: 0,
            }
          }
          return
        }

        const hit = pickElement(wx, wy)
        if (hit) {
          let next = selectionRef.current
          if (e.shiftKey) {
            next = next.includes(hit.id)
              ? next.filter((id) => id !== hit.id)
              : [...next, hit.id]
          } else if (!next.includes(hit.id)) {
            next = [hit.id]
          }
          onSelectionChange(next)
          selectionRef.current = next
          const els = next
            .map((id) => session.store.element(id))
            .filter((el): el is BoardElement => !!el && session.canEditElement(el.authorId))
          if (els.length) {
            const before = new Map<string, Patch>()
            for (const el of els) {
              before.set(
                el.id,
                el.type === 'stroke' ? snapshotFields(el, { points: [] }) : snapshotFields(el, { x: 0, y: 0 }),
              )
            }
            actionRef.current = { kind: 'move', ox: wx, oy: wy, els, before, lastSent: 0 }
          }
          return
        }

        marqueeRef.current = { x: wx, y: wy, w: 0, h: 0 }
        actionRef.current = {
          kind: 'marquee',
          ox: wx,
          oy: wy,
          additive: e.shiftKey,
          base: e.shiftKey ? [...selectionRef.current] : [],
        }
        if (!e.shiftKey) {
          onSelectionChange([])
          selectionRef.current = []
        }
        return
      }

      if (tool === 'eraser') {
        eraserRef.current = { x: wx, y: wy, r: cfg.eraser.size / 2 }
        actionRef.current = {
          kind: 'erase',
          pageId: pageRef.current,
          lx: wx,
          ly: wy,
          removed: [],
          indices: [],
          cut: new Map(),
          added: [],
        }
        dirtyRef.current = true
        return
      }

      if (tool === 'text') {
        createText(wx, wy)
        return
      }

      if (isShapeTool(tool)) {
        const el = makeShape(tool, wx, wy)
        draftRef.current = el
        actionRef.current = { kind: 'shape', el, ox: wx, oy: wy }
        onSelectionChange([])
        selectionRef.current = []
        dirtyRef.current = true
        return
      }

      if (isBrushTool(tool)) {
        const brushCfg = tool === 'pen' ? cfg.pen : cfg.highlighter
        // Real pressure comes from a pen and, on a MacBook, from Force Touch.
        // Everywhere else it is simulated from the speed of the movement.
        const useForce =
          FORCE_TOUCH_SUPPORTED && cfg.trackpadPressure && e.pointerType === 'mouse'
        const simulated = e.pointerType !== 'pen' && !useForce
        const style = {
          brush: tool,
          color: brushCfg.color,
          size: brushCfg.size,
          opacity: tool === 'highlighter' ? cfg.highlighter.opacity : 1,
          simulated,
        }
        const id = nanoid(10)
        const pressure = simulated ? 0.5 : useForce ? forceRef.current : e.pressure || 0.5
        const points = [wx, wy, pressure]
        localLiveRef.current = { id, pageId: pageRef.current, points, ...style }
        actionRef.current = { kind: 'draw', id, style, points, sentUpTo: 0, lastSent: 0, useForce }
        onSelectionChange([])
        selectionRef.current = []
        session.sendLive(id, pageRef.current, points, style)
        actionRef.current.sentUpTo = points.length
        dirtyRef.current = true
      }
    }

    /* --- move --- */
    const onPointerMove = (e: PointerEvent) => {
      const pointers = pointersRef.current
      const [sx, sy] = toScreen(e)
      if (pointers.has(e.pointerId)) {
        pointers.set(e.pointerId, { x: sx, y: sy, type: e.pointerType })
      }

      const touches = [...pointers.values()].filter((p) => p.type === 'touch')
      if (pinchRef.current && touches.length >= 2) {
        const [a, b] = touches
        const dist = Math.hypot(a.x - b.x, a.y - b.y)
        const cx = (a.x + b.x) / 2
        const cy = (a.y + b.y) / 2
        const prev = pinchRef.current
        const cam = camRef.current
        const [wx, wy] = screenToWorld(cam, cx, cy)
        cam.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (cam.zoom * dist) / (prev.dist || dist)))
        cam.x = wx - cx / cam.zoom
        cam.y = wy - cy / cam.zoom
        pinchRef.current = { dist, cx, cy }
        clampCamera()
        onZoomChange(cam.zoom)
        invalidate()
        return
      }

      // Before a gesture starts we track the sheet under the pointer; during a
      // gesture the page is fixed — except for the eraser, which roams the ribbon.
      if (!actionRef.current || actionRef.current.kind === 'erase') {
        resolvePage(toRibbon(e)[1])
      }
      const [wx, wy] = toWorld(e)
      lastPointRef.current = { x: wx, y: wy, pageId: pageRef.current }
      const action = actionRef.current
      const cfg = toolsRef.current

      if (!action) {
        if (cfg.tool === 'eraser') {
          eraserRef.current = { x: wx, y: wy, r: cfg.eraser.size / 2 }
          dirtyRef.current = true
        } else if (eraserRef.current) {
          eraserRef.current = null
          dirtyRef.current = true
        }
        if (cfg.tool === 'select') {
          const h = pickHandle(sx, sy)
          setCursorStyle(h ? HANDLE_CURSOR[h] : pickElement(wx, wy) ? 'move' : 'default')
        } else if (isBrushTool(cfg.tool) || isShapeTool(cfg.tool) || cfg.tool === 'text') {
          // Off the sheet the pen stays silent; show it through the cursor so the
          // board does not look unresponsive.
          const onPaper = wx >= 0 && wx <= BOARD_W && wy >= 0 && wy <= BOARD_H
          setCursorStyle(onPaper ? 'crosshair' : 'default')
        }
        session.sendCursor(pageRef.current, wx, wy, false)
        return
      }

      session.sendCursor(pageRef.current, wx, wy, action.kind === 'draw')

      switch (action.kind) {
        case 'pan': {
          const cam = camRef.current
          cam.x = action.cam.x - (sx - action.sx) / cam.zoom
          cam.y = action.cam.y - (sy - action.sy) / cam.zoom
          clampCamera()
          invalidate()
          return
        }
        case 'draw': {
          // A tablet is sampled hundreds of times per second, so take every
          // intermediate point of the frame. If there are none, use the event.
          const coalesced = e.getCoalescedEvents?.()
          const events = coalesced && coalesced.length ? coalesced : [e]
          const pts = action.points
          for (const ev of events) {
            const [x, y] = toWorld(ev)
            const n = pts.length
            const dx = x - pts[n - 3]
            const dy = y - pts[n - 2]
            if (dx * dx + dy * dy < POINT_EPS * POINT_EPS) continue
            pts.push(
              x,
              y,
              action.style.simulated
                ? 0.5
                : action.useForce
                  ? forceRef.current
                  : ev.pressure || 0.5,
            )
          }
          const now = performance.now()
          if (now - action.lastSent > LIVE_INTERVAL && pts.length > action.sentUpTo) {
            session.sendLive(action.id, pageRef.current, pts.slice(action.sentUpTo))
            action.sentUpTo = pts.length
            action.lastSent = now
          }
          dirtyRef.current = true
          return
        }
        case 'shape': {
          let w = wx - action.ox
          let h = wy - action.oy
          if (e.shiftKey) {
            const m = Math.max(Math.abs(w), Math.abs(h))
            w = Math.sign(w || 1) * m
            h = Math.sign(h || 1) * m
          }
          const el = action.el
          if (e.altKey) {
            el.x = action.ox - w
            el.y = action.oy - h
            el.w = w * 2
            el.h = h * 2
          } else {
            el.x = action.ox
            el.y = action.oy
            el.w = w
            el.h = h
          }
          draftRef.current = { ...el }
          dirtyRef.current = true
          return
        }
        case 'erase': {
          const r = cfg.eraser.size / 2
          if (action.pageId !== pageRef.current) {
            action.pageId = pageRef.current
            action.lx = wx
            action.ly = wy
          }
          eraserRef.current = { x: wx, y: wy, r }
          const els = session.store.elementsOf(pageRef.current)
          const kill: string[] = []
          for (let i = els.length - 1; i >= 0; i--) {
            const el = els[i]
            if (!session.canEditElement(el.authorId)) continue

            // The partial eraser cuts handwriting only: shapes, text and images
            // are removed whole and only in "object" mode.
            if (cfg.eraser.mode === 'partial' && el.type === 'stroke') {
              const runs = erasePartOfStroke(el, action.lx, action.ly, wx, wy, r)
              if (!runs) continue
              if (!action.cut.has(el.id)) action.cut.set(el.id, [...el.points])
              if (!runs.length) {
                action.removed.push(structuredClone(el))
                action.indices.push(session.store.doc.order.indexOf(el.id))
                kill.push(el.id)
                continue
              }
              session.store.applyLocal({ t: 'update', id: el.id, patch: { points: runs[0] } })
              for (const run of runs.slice(1)) {
                const piece: BoardElement = {
                  ...structuredClone(el),
                  id: nanoid(10),
                  points: run,
                }
                action.added.push(piece.id)
                session.store.applyLocal({ t: 'add', el: piece })
              }
              continue
            }

            if (cfg.eraser.mode === 'partial') continue

            if (strokeIntersects(el, action.lx, action.ly, wx, wy, r)) {
              action.removed.push(structuredClone(el))
              action.indices.push(session.store.doc.order.indexOf(el.id))
              kill.push(el.id)
            }
          }
          if (kill.length) session.store.applyLocal({ t: 'remove', ids: kill })
          action.lx = wx
          action.ly = wy
          dirtyRef.current = true
          return
        }
        case 'move': {
          // Patches are computed from the original values, so roll the elements
          // back to how they were when the gesture started.
          for (const el of action.els) {
            const before = action.before.get(el.id)
            if (before) Object.assign(el as object, before)
          }
          const patches = moveElements(action.els, wx - action.ox, wy - action.oy)
          const now = performance.now()
          const send = now - action.lastSent > 40
          if (send) action.lastSent = now
          applyPatches(patches, send)
          return
        }
        case 'resize': {
          const [lx, ly] =
            action.els.length === 1 ? toLocal(action.els[0], wx, wy) : [wx, wy]
          for (const el of action.els) {
            const before = action.before.get(el.id)
            if (before) Object.assign(el as object, before)
          }
          // Dragging an image by a corner keeps its aspect ratio: a stretched
          // photo is almost always a mistake. Shift restores free resizing.
          const corner = action.handle.length === 2
          const imageCorner =
            corner && action.els.length === 1 && action.els[0].type === 'image'
          const { patches } = resizeElements(
            action.els,
            action.bounds,
            action.handle,
            lx - action.ox,
            ly - action.oy,
            imageCorner ? !e.shiftKey : e.shiftKey,
          )
          const now = performance.now()
          const send = now - action.lastSent > 40
          if (send) action.lastSent = now
          applyPatches(patches, send)
          return
        }
        case 'rotate': {
          let angle = Math.atan2(wy - action.cy, wx - action.cx) - action.start
          if (e.shiftKey) angle = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12)
          for (const el of action.els) {
            const before = action.before.get(el.id)
            if (before) Object.assign(el as object, before)
          }
          const patches = rotateElements(action.els, action.cx, action.cy, angle)
          action.applied = angle
          const now = performance.now()
          const send = now - action.lastSent > 40
          if (send) action.lastSent = now
          applyPatches(patches, send)
          return
        }
        case 'marquee': {
          const rect = {
            x: Math.min(action.ox, wx),
            y: Math.min(action.oy, wy),
            w: Math.abs(wx - action.ox),
            h: Math.abs(wy - action.oy),
          }
          marqueeRef.current = rect
          const inside = session.store
            .elementsOf(pageRef.current)
            .filter((el) => elementInRect(el, rect))
            .map((el) => el.id)
          const next = action.additive
            ? [...new Set([...action.base, ...inside])]
            : inside
          selectionRef.current = next
          onSelectionChange(next)
          dirtyRef.current = true
        }
      }
    }

    /* --- release --- */
    const onPointerUp = (e: PointerEvent) => {
      const pointers = pointersRef.current
      pointers.delete(e.pointerId)
      if (pointers.size < 2) pinchRef.current = null
      try {
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
      } catch {
        /* already released */
      }

      const action = actionRef.current
      if (!action) return
      actionRef.current = null
      setCursorStyle(toolsRef.current.tool === 'select' ? 'default' : 'crosshair')

      switch (action.kind) {
        case 'draw': {
          const live = localLiveRef.current
          localLiveRef.current = null
          if (!live || action.points.length < 3) {
            session.sendLive(action.id, pageRef.current, [], undefined, true)
            break
          }
          const el: BoardElement = {
            id: action.id,
            type: 'stroke',
            pageId: pageRef.current,
            authorId: session.selfId,
            createdAt: Date.now(),
            points: action.points,
            ...action.style,
          }
          session.store.commit({ t: 'add', el })
          session.sendLive(action.id, pageRef.current, [], undefined, true)
          break
        }
        case 'shape': {
          const el = action.el
          draftRef.current = null
          if (Math.abs(el.w) < 3 && Math.abs(el.h) < 3) break
          if (el.w < 0) {
            el.x += el.w
            el.w = -el.w
          }
          if (el.h < 0 && el.shape !== 'line' && el.shape !== 'arrow') {
            el.y += el.h
            el.h = -el.h
          }
          session.store.commit({ t: 'add', el })
          onSelectionChange([el.id])
          selectionRef.current = [el.id]
          break
        }
        case 'erase': {
          const undo: Op[] = []
          const redo: Op[] = []
          if (action.removed.length) {
            // Restoring must come before putting the points back: an element that
            // was first cut and then erased completely has to return to the
            // document first.
            undo.push(
              ...action.removed.map((el, i) => ({
                t: 'add' as const,
                el,
                index: action.indices[i],
              })),
            )
            redo.push({ t: 'remove', ids: action.removed.map((el) => el.id) })
          }
          for (const [id, points] of action.cut) {
            const el = session.store.element(id)
            undo.push({ t: 'update', id, patch: { points } })
            if (el?.type === 'stroke') {
              redo.push({ t: 'update', id, patch: { points: [...el.points] } })
            }
          }
          const pieces = action.added
            .map((id) => session.store.element(id))
            .filter((el): el is BoardElement => !!el)
          if (pieces.length) {
            undo.push({ t: 'remove', ids: pieces.map((el) => el.id) })
            redo.push(...pieces.map((el) => ({ t: 'add' as const, el: structuredClone(el) })))
          }
          session.store.pushHistory(undo, redo)
          eraserRef.current = null
          break
        }
        case 'move':
        case 'resize':
        case 'rotate':
          finishDrag(action)
          break
        case 'marquee':
          marqueeRef.current = null
          break
      }
      dirtyRef.current = true
    }

    const onPointerCancel = (e: PointerEvent) => {
      pointersRef.current.delete(e.pointerId)
      pinchRef.current = null
      if (actionRef.current?.kind === 'draw') {
        session.sendLive(actionRef.current.id, pageRef.current, [], undefined, true)
      }
      beginGestureCleanup()
    }

    const onPointerLeave = () => {
      if (!actionRef.current && eraserRef.current) {
        eraserRef.current = null
        dirtyRef.current = true
      }
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const [sx, sy] = toScreen(e)
      if (e.ctrlKey || e.metaKey) {
        zoomAt(Math.exp(-e.deltaY * 0.01), sx, sy)
        return
      }
      const cam = camRef.current
      const k = e.deltaMode === 1 ? 16 : 1
      cam.x += (e.deltaX * k) / cam.zoom
      cam.y += (e.deltaY * k) / cam.zoom
      clampCamera()
      invalidate()
    }

    const onDblClick = (e: MouseEvent) => {
      const [wx, wy] = toWorld(e)
      const hit = pickElement(wx, wy)
      if (hit?.type === 'text' && session.canEditElement(hit.authorId)) {
        setEditor({ id: hit.id, isNew: false, value: hit.text })
      } else if (!hit && session.canDraw && toolsRef.current.tool === 'select') {
        createText(wx, wy)
      }
    }

    const onContextMenu = (e: MouseEvent) => e.preventDefault()

    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      setDropping(true)
    }
    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget && canvas.contains(e.relatedTarget as Node)) return
      setDropping(false)
    }
    const onDrop = (e: DragEvent) => {
      const files = [...(e.dataTransfer?.files ?? [])]
      if (!files.length) return
      e.preventDefault()
      setDropping(false)
      void insertImages(files, pointOnPage(e))
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerCancel)
    canvas.addEventListener('pointerleave', onPointerLeave)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('dblclick', onDblClick)
    canvas.addEventListener('contextmenu', onContextMenu)
    canvas.addEventListener('dragover', onDragOver)
    canvas.addEventListener('dragleave', onDragLeave)
    canvas.addEventListener('drop', onDrop)

    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerCancel)
      canvas.removeEventListener('pointerleave', onPointerLeave)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('dblclick', onDblClick)
      canvas.removeEventListener('contextmenu', onContextMenu)
      canvas.removeEventListener('dragover', onDragOver)
      canvas.removeEventListener('dragleave', onDragLeave)
      canvas.removeEventListener('drop', onDrop)
    }
  }, [
    clampCamera,
    createText,
    editor,
    insertImages,
    invalidate,
    makeShape,
    onSelectionChange,
    onZoomChange,
    pickElement,
    resolvePage,
    toRibbon,
    pickHandle,
    pointOnPage,
    selectionBox,
    session,
    toScreen,
    toWorld,
    zoomAt,
  ])

  /* ---------------- keyboard: space pans ---------------- */

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !spaceRef.current && !editor) {
        spaceRef.current = true
        setCursorStyle('grab')
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceRef.current = false
        setCursorStyle(toolsRef.current.tool === 'select' ? 'default' : 'crosshair')
      }
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [editor])

  useEffect(() => {
    setCursorStyle(
      tools.tool === 'select'
        ? 'default'
        : tools.tool === 'pan' || tools.tool === 'paper'
          ? 'grab'
          : 'crosshair',
    )
  }, [tools.tool])

  /* ---------------- text editor ---------------- */

  const closeEditor = useCallback(
    (commit: boolean) => {
      const state = editor
      if (!state) return
      setEditor(null)
      const el = session.store.element(state.id)
      if (!el || el.type !== 'text') return
      const value = commit ? state.value.trim() : el.text
      if (!value) {
        if (state.isNew) session.store.commit({ t: 'remove', ids: [state.id] })
        return
      }
      if (value === el.text) return
      const canvas = document.createElement('canvas').getContext('2d')!
      canvas.font = `${el.fontSize}px "Inter", "Segoe UI", system-ui, sans-serif`
      const lines = value.split('\n').length
      session.store.commit({
        t: 'update',
        id: state.id,
        patch: { text: value, h: Math.max(el.fontSize * 1.3, lines * el.fontSize * 1.28) },
      })
    },
    [editor, session],
  )

  const editorEl = editor ? session.store.element(editor.id) : null
  let editorStyle: React.CSSProperties | null = null
  if (editorEl?.type === 'text') {
    const cam = camRef.current
    const [sx, sy] = worldToScreen(cam, editorEl.x, editorEl.y + topOfPage(editorEl.pageId))
    editorStyle = {
      left: sx,
      top: sy,
      width: editorEl.w * cam.zoom,
      minHeight: editorEl.fontSize * 1.3 * cam.zoom,
      fontSize: editorEl.fontSize * cam.zoom,
      lineHeight: 1.28,
      color: editorEl.color,
    }
  }

  return (
    <div className={`board-wrap${dropping ? ' dropping' : ''}`} ref={wrapRef}>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          void insertImages([...(e.target.files ?? [])])
          e.target.value = ''
        }}
      />
      <canvas
        ref={canvasRef}
        className="board-canvas"
        style={{ cursor: cursorStyle, touchAction: 'none' }}
      />
      {editor && editorStyle && (
        <textarea
          className="text-editor"
          style={editorStyle}
          autoFocus
          value={editor.value}
          onChange={(e) => setEditor({ ...editor, value: e.target.value })}
          onBlur={() => closeEditor(true)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape') {
              e.preventDefault()
              closeEditor(false)
            }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              closeEditor(true)
            }
          }}
          onInput={(e) => {
            const ta = e.currentTarget
            ta.style.height = 'auto'
            ta.style.height = `${ta.scrollHeight}px`
          }}
        />
      )}
      {notice && <div className="notice">{notice}</div>}
      {dropping && <div className="drop-hint">{t('canvas.dropHint')}</div>}
      {!session.canDraw && (
        <div className="view-only-badge">
          {session.role === 'viewer' ? t('canvas.viewOnly') : t('canvas.locked')}
        </div>
      )}
    </div>
  )
})
