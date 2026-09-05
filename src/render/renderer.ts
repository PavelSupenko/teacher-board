import {
  arrowHead,
  handlePositions,
  HANDLE_ORDER,
  localBounds,
  shapePoints,
  unionBounds,
  type Rect,
} from '../model/geometry'
import { pageElements } from '../../shared/doc.js'
import { livePath, strokePath } from './stroke'
import { cachedImage } from '../input/media'
import { drawGrain, drawRuling, lookOf } from './paper'
import type {
  BoardDoc,
  BoardElement,
  ImageElement,
  LiveStroke,
  PaperSettings,
  ShapeElement,
  TextElement,
  Theme,
} from '../model/types'
import { BOARD_H, BOARD_W, MM } from '../model/types'
import { PAGE_STRIDE, pageTop } from '../model/ribbon'

export interface Camera {
  x: number
  y: number
  zoom: number
}

export type { Theme } from '../model/types'

export interface RemoteCursor {
  id: string
  name: string
  color: string
  /** Coordinates in the participant's own page. */
  pageId: string
  x: number
  y: number
  drawing: boolean
}

export interface RenderState {
  doc: BoardDoc
  /** How the paper looks: tint, ruling, margins, grain. */
  paper: PaperSettings
  /** Page whose coordinates the marquee and eraser are expressed in. */
  pageId: string
  camera: Camera
  theme: Theme
  /** Document change counter; the static layer is rebuilt when it moves. */
  docVersion: number
  liveStrokes: LiveStroke[]
  draftShape: ShapeElement | null
  selection: string[]
  marquee: Rect | null
  cursors: RemoteCursor[]
  eraser: { x: number; y: number; r: number } | null
  readOnly: boolean
}

export const worldToScreen = (c: Camera, x: number, y: number): [number, number] => [
  (x - c.x) * c.zoom,
  (y - c.y) * c.zoom,
]

export const screenToWorld = (c: Camera, x: number, y: number): [number, number] => [
  x / c.zoom + c.x,
  y / c.zoom + c.y,
]

/* ------------------------------------------------------------------ */
/* Drawing primitives, in page coordinates                             */
/* ------------------------------------------------------------------ */

export function shapeCanvasPath(el: {
  shape: ShapeElement['shape']
  x: number
  y: number
  w: number
  h: number
}): Path2D {
  const path = new Path2D()
  if (el.shape === 'ellipse') {
    path.ellipse(
      el.x + el.w / 2,
      el.y + el.h / 2,
      Math.abs(el.w) / 2,
      Math.abs(el.h) / 2,
      0,
      0,
      Math.PI * 2,
    )
    return path
  }
  const geom = shapePoints(el.shape, el.x, el.y, el.w, el.h)
  if (!geom || !geom.pts.length) return path
  path.moveTo(geom.pts[0][0], geom.pts[0][1])
  for (let i = 1; i < geom.pts.length; i++) path.lineTo(geom.pts[i][0], geom.pts[i][1])
  if (geom.closed) path.closePath()
  return path
}

export function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    if (!paragraph) {
      lines.push('')
      continue
    }
    let line = ''
    for (const word of paragraph.split(' ')) {
      const test = line ? `${line} ${word}` : word
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line)
        line = word
      } else {
        line = test
      }
    }
    lines.push(line)
  }
  return lines
}

export const textFont = (el: Pick<TextElement, 'fontSize'>): string =>
  `${el.fontSize}px "Inter", "Segoe UI", system-ui, sans-serif`

export const TEXT_LINE_HEIGHT = 1.28

function drawShape(ctx: CanvasRenderingContext2D, el: ShapeElement) {
  const cx = el.x + el.w / 2
  const cy = el.y + el.h / 2
  ctx.save()
  ctx.globalAlpha = el.opacity
  if (el.rotation) {
    ctx.translate(cx, cy)
    ctx.rotate(el.rotation)
    ctx.translate(-cx, -cy)
  }
  ctx.lineWidth = el.size
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.strokeStyle = el.color

  if (el.shape === 'arrow') {
    ctx.beginPath()
    ctx.moveTo(el.x, el.y)
    ctx.lineTo(el.x + el.w, el.y + el.h)
    for (const seg of arrowHead(el.x, el.y, el.w, el.h, el.size)) {
      ctx.moveTo(seg[0][0], seg[0][1])
      ctx.lineTo(seg[1][0], seg[1][1])
    }
    ctx.stroke()
    ctx.restore()
    return
  }

  const path = shapeCanvasPath(el)
  if (el.fill && el.shape !== 'line') {
    ctx.fillStyle = el.fill
    ctx.fill(path)
  }
  if (el.size > 0) ctx.stroke(path)
  ctx.restore()
}

function drawText(ctx: CanvasRenderingContext2D, el: TextElement) {
  const cx = el.x + el.w / 2
  const cy = el.y + el.h / 2
  ctx.save()
  ctx.globalAlpha = el.opacity
  if (el.rotation) {
    ctx.translate(cx, cy)
    ctx.rotate(el.rotation)
    ctx.translate(-cx, -cy)
  }
  ctx.font = textFont(el)
  ctx.textBaseline = 'top'
  ctx.fillStyle = el.color
  const lh = el.fontSize * TEXT_LINE_HEIGHT
  wrapText(ctx, el.text, el.w).forEach((line, i) => {
    ctx.fillText(line, el.x, el.y + i * lh)
  })
  ctx.restore()
}

function drawImageEl(
  ctx: CanvasRenderingContext2D,
  el: ImageElement,
  onReady: () => void,
) {
  const cx = el.x + el.w / 2
  const cy = el.y + el.h / 2
  ctx.save()
  ctx.globalAlpha = el.opacity
  if (el.rotation) {
    ctx.translate(cx, cy)
    ctx.rotate(el.rotation)
    ctx.translate(-cx, -cy)
  }
  const img = cachedImage(el.src, onReady)
  if (img) {
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, el.x, el.y, el.w, el.h)
  } else {
    // While the image loads, show where it will sit instead of nothing.
    ctx.fillStyle = 'rgba(148, 163, 184, 0.18)'
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.55)'
    ctx.lineWidth = 1
    ctx.setLineDash([6, 4])
    ctx.fillRect(el.x, el.y, el.w, el.h)
    ctx.strokeRect(el.x, el.y, el.w, el.h)
  }
  ctx.restore()
}

export function drawElement(
  ctx: CanvasRenderingContext2D,
  el: BoardElement,
  onImageReady: () => void = () => {},
) {
  switch (el.type) {
    case 'stroke': {
      if (el.points.length < 3) return
      ctx.save()
      ctx.globalAlpha = el.opacity
      ctx.fillStyle = el.color
      ctx.fill(strokePath(el))
      ctx.restore()
      return
    }
    case 'shape':
      drawShape(ctx, el)
      return
    case 'text':
      drawText(ctx, el)
      return
    case 'image':
      drawImageEl(ctx, el, onImageReady)
  }
}

export function drawLiveStroke(ctx: CanvasRenderingContext2D, live: LiveStroke, done = false) {
  if (live.points.length < 3) return
  ctx.save()
  ctx.globalAlpha = live.opacity
  ctx.fillStyle = live.color
  ctx.fill(livePath(live, done))
  ctx.restore()
}

/** Fills one sheet: tint, optional grain, then the ruling inside the margins. */
export function drawPageBackground(
  ctx: CanvasRenderingContext2D,
  paper: PaperSettings,
  theme: Theme,
  pixelScale = 1,
) {
  const look = lookOf(paper, theme)
  ctx.save()
  ctx.fillStyle = look.paper
  ctx.fillRect(0, 0, BOARD_W, BOARD_H)
  ctx.restore()
  if (paper.texture) drawGrain(ctx, pixelScale)
  drawRuling(ctx, paper, theme)
}

/* ------------------------------------------------------------------ */
/* Renderer: the static layer is cached, live content is drawn on top   */
/* ------------------------------------------------------------------ */

export class BoardRenderer {
  private ctx: CanvasRenderingContext2D
  private staticCanvas: HTMLCanvasElement
  private staticCtx: CanvasRenderingContext2D
  private width = 0
  private height = 0
  private dpr = 1
  private staticKey = ''

  /** Called once an image finishes loading and the layer needs a rebuild. */
  onImageLoad: () => void = () => {}

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('2D context unavailable')
    this.ctx = ctx
    this.staticCanvas = document.createElement('canvas')
    const sctx = this.staticCanvas.getContext('2d')
    if (!sctx) throw new Error('2D context unavailable')
    this.staticCtx = sctx
  }

  resize(width: number, height: number, dpr: number) {
    if (this.width === width && this.height === height && this.dpr === dpr) return
    this.width = width
    this.height = height
    this.dpr = dpr
    for (const c of [this.canvas, this.staticCanvas]) {
      c.width = Math.max(1, Math.round(width * dpr))
      c.height = Math.max(1, Math.round(height * dpr))
    }
    this.canvas.style.width = `${width}px`
    this.canvas.style.height = `${height}px`
    this.staticKey = ''
  }

  invalidate() {
    this.staticKey = ''
  }

  private applyCamera(ctx: CanvasRenderingContext2D, cam: Camera) {
    const k = this.dpr * cam.zoom
    ctx.setTransform(k, 0, 0, k, -cam.x * k, -cam.y * k)
  }

  /** Offset of a page, looked up by its identifier. */
  private topOf(doc: BoardDoc, pageId: string): number {
    const i = doc.pages.findIndex((p) => p.id === pageId)
    return pageTop(Math.max(0, i))
  }

  private rebuildStatic(state: RenderState) {
    const { doc, camera, theme, paper } = state
    const look = lookOf(paper, theme)
    const ctx = this.staticCtx
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = look.outside
    ctx.fillRect(0, 0, this.staticCanvas.width, this.staticCanvas.height)

    this.applyCamera(ctx, camera)
    const viewTop = camera.y
    const viewBottom = camera.y + this.height / camera.zoom
    // One tile pixel per device pixel, so the grain never shimmers on zoom.
    const grainScale = 1 / (this.dpr * camera.zoom)

    doc.pages.forEach((_page, index) => {
      const top = pageTop(index)
      // Draw only the sheets inside the viewport: the ribbon can be long.
      if (top + BOARD_H < viewTop - PAGE_STRIDE || top > viewBottom + PAGE_STRIDE) return

      ctx.save()
      ctx.translate(0, top)

      ctx.save()
      // Shadow blur and offset are in canvas pixels and ignore the transform,
      // so they must not be divided by the zoom: at low zoom the shadow would
      // swell into a halo around the sheet.
      ctx.shadowColor = look.shadow
      ctx.shadowBlur = 16 * this.dpr
      ctx.shadowOffsetY = 5 * this.dpr
      ctx.fillStyle = look.paper
      ctx.fillRect(0, 0, BOARD_W, BOARD_H)
      ctx.restore()

      ctx.save()
      ctx.beginPath()
      ctx.rect(0, 0, BOARD_W, BOARD_H)
      ctx.clip()
      drawPageBackground(ctx, paper, theme, grainScale)
      for (const el of pageElements(doc, doc.pages[index].id)) {
        drawElement(ctx, el, this.onImageLoad)
      }
      ctx.restore()

      // The sheet number sits in the gap above it, to keep a long ribbon readable.
      if (index > 0) {
        ctx.fillStyle = look.ruling
        ctx.font = `${Math.round(9 * MM)}px "Inter", system-ui, sans-serif`
        ctx.textBaseline = 'bottom'
        ctx.fillText(`${index + 1}`, 0, -4 * MM)
      }
      ctx.restore()
    })
  }

  render(state: RenderState) {
    const { camera } = state
    const key = [
      state.docVersion,
      state.pageId,
      state.theme,
      JSON.stringify(state.paper),
      camera.x.toFixed(2),
      camera.y.toFixed(2),
      camera.zoom.toFixed(4),
      this.width,
      this.height,
      this.dpr,
    ].join('|')
    if (key !== this.staticKey) {
      this.rebuildStatic(state)
      this.staticKey = key
    }

    const ctx = this.ctx
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.drawImage(this.staticCanvas, 0, 0)

    this.applyCamera(ctx, camera)
    const onPage = (pageId: string, paint: () => void) => {
      ctx.save()
      ctx.translate(0, this.topOf(state.doc, pageId))
      ctx.beginPath()
      ctx.rect(0, 0, BOARD_W, BOARD_H)
      ctx.clip()
      paint()
      ctx.restore()
    }
    for (const live of state.liveStrokes) {
      onPage(live.pageId, () => drawLiveStroke(ctx, live))
    }
    if (state.draftShape) {
      const draft = state.draftShape
      onPage(draft.pageId, () => drawElement(ctx, draft))
    }

    this.drawOverlay(state)
  }

  /** Selection, marquee and peer cursors, in screen coordinates. */
  private drawOverlay(state: RenderState) {
    const ctx = this.ctx
    const { camera, doc, selection } = state
    const activeTop = this.topOf(doc, state.pageId)
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.lineCap = 'butt'
    ctx.lineJoin = 'miter'

    const accent = '#3b82f6'

    if (selection.length) {
      const els = selection.map((id) => doc.elements[id]).filter(Boolean) as BoardElement[]
      const single = els.length === 1 ? els[0] : null
      const rotation = single && single.type !== 'stroke' ? single.rotation : 0
      const box: Rect | null = single
        ? { ...localBounds(single) }
        : unionBounds(els)
      const selTop = els.length ? this.topOf(doc, els[0].pageId) : activeTop
      if (box) {
        const cx = box.x + box.w / 2
        const cy = box.y + box.h / 2 + selTop
        const [scx, scy] = worldToScreen(camera, cx, cy)
        ctx.save()
        ctx.translate(scx, scy)
        ctx.rotate(rotation)
        ctx.scale(camera.zoom, camera.zoom)
        ctx.translate(-cx, -cy + selTop)
        ctx.strokeStyle = accent
        ctx.lineWidth = 1.5 / camera.zoom
        ctx.setLineDash([6 / camera.zoom, 4 / camera.zoom])
        ctx.strokeRect(box.x, box.y, box.w, box.h)
        ctx.restore()

        if (!state.readOnly) {
          const pos = handlePositions(box, rotation)
          const r = 5
          ctx.setLineDash([])
          ctx.lineWidth = 1.5
          ctx.strokeStyle = accent
          ctx.fillStyle = '#ffffff'
          const [rx, ry] = worldToScreen(camera, pos.rotate[0], pos.rotate[1] + selTop)
          const [nx, ny] = worldToScreen(camera, pos.n[0], pos.n[1] + selTop)
          ctx.beginPath()
          ctx.moveTo(nx, ny)
          ctx.lineTo(rx, ry)
          ctx.stroke()
          ctx.beginPath()
          ctx.arc(rx, ry, r + 1, 0, Math.PI * 2)
          ctx.fill()
          ctx.stroke()
          for (const h of HANDLE_ORDER) {
            const [hx, hy] = worldToScreen(camera, pos[h][0], pos[h][1] + selTop)
            ctx.beginPath()
            ctx.rect(hx - r, hy - r, r * 2, r * 2)
            ctx.fill()
            ctx.stroke()
          }
        }
      }
    }

    if (state.marquee) {
      const [x, y] = worldToScreen(camera, state.marquee.x, state.marquee.y + activeTop)
      const w = state.marquee.w * camera.zoom
      const h = state.marquee.h * camera.zoom
      ctx.save()
      ctx.fillStyle = 'rgba(59, 130, 246, 0.12)'
      ctx.strokeStyle = accent
      ctx.lineWidth = 1
      ctx.setLineDash([4, 3])
      ctx.fillRect(x, y, w, h)
      ctx.strokeRect(x, y, w, h)
      ctx.restore()
    }

    if (state.eraser) {
      const [x, y] = worldToScreen(camera, state.eraser.x, state.eraser.y + activeTop)
      ctx.save()
      ctx.strokeStyle = state.theme === 'dark' ? '#e2e8f0' : '#334155'
      ctx.fillStyle = state.theme === 'dark' ? 'rgba(226,232,240,0.12)' : 'rgba(51,65,85,0.10)'
      ctx.lineWidth = 1.5
      ctx.setLineDash([])
      ctx.beginPath()
      ctx.arc(x, y, state.eraser.r * camera.zoom, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
      ctx.restore()
    }

    for (const cur of state.cursors) {
      if (cur.x < -50 || cur.y < -50) continue
      const [x, y] = worldToScreen(camera, cur.x, cur.y + this.topOf(doc, cur.pageId))
      if (x < -40 || y < -40 || x > this.width + 40 || y > this.height + 40) continue
      ctx.save()
      ctx.setLineDash([])
      ctx.fillStyle = cur.color
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(x + 11, y + 11)
      ctx.lineTo(x + 4.5, y + 11.5)
      ctx.lineTo(x + 1.5, y + 17)
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
      if (cur.drawing) {
        ctx.beginPath()
        ctx.arc(x, y, 13, 0, Math.PI * 2)
        ctx.strokeStyle = cur.color
        ctx.globalAlpha = 0.55
        ctx.stroke()
        ctx.globalAlpha = 1
      }
      ctx.font = '600 11px system-ui, sans-serif'
      const label = cur.name.slice(0, 18)
      const w = ctx.measureText(label).width
      ctx.fillStyle = cur.color
      ctx.beginPath()
      ctx.roundRect(x + 12, y + 14, w + 12, 18, 9)
      ctx.fill()
      ctx.fillStyle = '#ffffff'
      ctx.fillText(label, x + 18, y + 27)
      ctx.restore()
    }
  }
}
