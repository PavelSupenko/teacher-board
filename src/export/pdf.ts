import { jsPDF } from 'jspdf'
import { ellipsePoints, rotatePoint, shapePoints, arrowHead } from '../model/geometry'
import { outlinePoints } from '../render/stroke'
import { drawElement, drawPageBackground, textFont, TEXT_LINE_HEIGHT, wrapText } from '../render/renderer'
import { lookOf, makeGrainTile, rulingArea } from '../render/paper'
import { pageElements, pageIsEmpty } from '../../shared/doc.js'
import { preloadImages } from '../input/media'
import type {
  BoardDoc,
  BoardElement,
  ImageElement,
  PaperSettings,
  ShapeElement,
  TextElement,
  Theme,
} from '../model/types'
import { BOARD_H, BOARD_W, DEFAULT_PAPER, MM } from '../model/types'

type RGBA = { r: number; g: number; b: number; a: number }

const NAMED: Record<string, string> = { white: '#ffffff', black: '#000000' }

export function parseColor(input: string): RGBA {
  const c = (NAMED[input] ?? input).trim()
  if (c.startsWith('#')) {
    let hex = c.slice(1)
    if (hex.length === 3 || hex.length === 4) hex = [...hex].map((ch) => ch + ch).join('')
    const n = parseInt(hex.slice(0, 6), 16)
    const a = hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a }
  }
  const m = c.match(/rgba?\(([^)]+)\)/i)
  if (m) {
    const parts = m[1].split(/[,/\s]+/).filter(Boolean).map(Number)
    return { r: parts[0] || 0, g: parts[1] || 0, b: parts[2] || 0, a: parts[3] ?? 1 }
  }
  return { r: 0, g: 0, b: 0, a: 1 }
}

/**
 * Ramer-Douglas-Peucker simplification, which keeps the PDF compact.
 *
 * Stroke outlines are closed: the last point coincides with the first. The
 * first-to-last chord then degenerates into a point, and the distance has to be
 * measured to that point — otherwise the whole outline collapses and the stroke
 * disappears from the file.
 */
function simplify(input: [number, number][], tol: number): [number, number][] {
  // Drop the duplicated closing point; the close-path operator restores it.
  let pts = input
  const n0 = pts.length
  if (
    n0 > 2 &&
    Math.abs(pts[0][0] - pts[n0 - 1][0]) < 1e-9 &&
    Math.abs(pts[0][1] - pts[n0 - 1][1]) < 1e-9
  ) {
    pts = pts.slice(0, -1)
  }
  if (pts.length < 3) return pts
  const keep = new Uint8Array(pts.length)
  keep[0] = 1
  keep[pts.length - 1] = 1
  const stack: [number, number][] = [[0, pts.length - 1]]
  while (stack.length) {
    const [first, last] = stack.pop()!
    let maxDist = 0
    let index = -1
    const [ax, ay] = pts[first]
    const [bx, by] = pts[last]
    const dx = bx - ax
    const dy = by - ay
    const len = Math.hypot(dx, dy)
    const degenerate = len < 1e-9
    for (let i = first + 1; i < last; i++) {
      const d = degenerate
        ? Math.hypot(pts[i][0] - ax, pts[i][1] - ay)
        : Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / len
      if (d > maxDist) {
        maxDist = d
        index = i
      }
    }
    if (maxDist > tol && index > 0) {
      keep[index] = 1
      stack.push([first, index], [index, last])
    }
  }
  return pts.filter((_, i) => keep[i])
}

const toDeltas = (pts: [number, number][]): [number, number][] => {
  const out: [number, number][] = []
  for (let i = 1; i < pts.length; i++) {
    out.push([pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]])
  }
  return out
}

function setOpacity(pdf: jsPDF, alpha: number) {
  try {
    const GState = (pdf as unknown as { GState: new (o: Record<string, number>) => unknown }).GState
    pdf.setGState(new GState({ opacity: alpha, 'stroke-opacity': alpha }) as never)
  } catch {
    /* without transparency support, draw opaque */
  }
}

function polygon(
  pdf: jsPDF,
  pts: [number, number][],
  style: 'S' | 'F' | 'FD',
  closed: boolean,
) {
  if (pts.length < 2) return
  pdf.lines(toDeltas(pts), pts[0][0], pts[0][1], [1, 1], style, closed)
}

/** Element coordinates with its rotation applied. */
function applyRotation(
  el: ShapeElement,
  pts: [number, number][],
): [number, number][] {
  if (!el.rotation) return pts
  const cx = el.x + el.w / 2
  const cy = el.y + el.h / 2
  return pts.map(([x, y]) => rotatePoint(x, y, cx, cy, el.rotation))
}

function drawShapePdf(pdf: jsPDF, el: ShapeElement) {
  const stroke = parseColor(el.color)
  pdf.setDrawColor(stroke.r, stroke.g, stroke.b)
  pdf.setLineWidth(el.size)
  pdf.setLineJoin('round')
  pdf.setLineCap('round')
  setOpacity(pdf, el.opacity)

  if (el.shape === 'arrow') {
    polygon(pdf, applyRotation(el, [[el.x, el.y], [el.x + el.w, el.y + el.h]]), 'S', false)
    for (const seg of arrowHead(el.x, el.y, el.w, el.h, el.size)) {
      polygon(pdf, applyRotation(el, seg as [number, number][]), 'S', false)
    }
    return
  }

  const base =
    el.shape === 'ellipse'
      ? { pts: ellipsePoints(el.x, el.y, el.w, el.h, 72), closed: true }
      : shapePoints(el.shape, el.x, el.y, el.w, el.h)
  if (!base) return
  const pts = applyRotation(el, base.pts)

  if (el.fill && el.shape !== 'line') {
    const f = parseColor(el.fill)
    pdf.setFillColor(f.r, f.g, f.b)
    polygon(pdf, pts, el.size > 0 ? 'FD' : 'F', true)
  } else {
    polygon(pdf, pts, 'S', base.closed)
  }
}

function drawStrokePdf(pdf: jsPDF, el: Extract<BoardElement, { type: 'stroke' }>) {
  if (el.points.length < 3) return
  const outline = outlinePoints(el.points, el, true) as [number, number][]
  if (outline.length < 3) return
  const pts = simplify(outline, 0.32)
  const c = parseColor(el.color)
  pdf.setFillColor(c.r, c.g, c.b)
  setOpacity(pdf, el.opacity * c.a)
  polygon(pdf, pts, 'F', true)
}

/** Bounding box of a rotated element, with padding. */
function rotatedBox(
  x: number,
  y: number,
  w: number,
  h: number,
  rotation: number,
  pad: number,
) {
  const cx = x + w / 2
  const cy = y + h / 2
  const corners = (
    [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ] as [number, number][]
  ).map(([px, py]) => rotatePoint(px, py, cx, cy, rotation))
  const xs = corners.map((c) => c[0])
  const ys = corners.map((c) => c[1])
  return {
    x: Math.min(...xs) - pad,
    y: Math.min(...ys) - pad,
    w: Math.max(...xs) - Math.min(...xs) + pad * 2,
    h: Math.max(...ys) - Math.min(...ys) + pad * 2,
  }
}

/**
 * Draws an element into its own canvas the size of its bounding box and places
 * it as an image. That way the rotation is computed here rather than relying on
 * jsPDF's image rotation.
 */
function addRaster(
  pdf: jsPDF,
  box: { x: number; y: number; w: number; h: number },
  scale: number,
  paint: (ctx: CanvasRenderingContext2D) => void,
  opacity: number,
) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(box.w * scale))
  canvas.height = Math.max(1, Math.ceil(box.h * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.scale(scale, scale)
  ctx.translate(-box.x, -box.y)
  paint(ctx)
  setOpacity(pdf, opacity)
  pdf.addImage(canvas.toDataURL('image/png'), 'PNG', box.x, box.y, box.w, box.h, undefined, 'FAST')
}

/**
 * Text is rasterised: the built-in PDF fonts cover Latin only, and embedding a
 * TTF for a few captions would add hundreds of kilobytes to every file.
 */
function drawTextPdf(pdf: jsPDF, el: TextElement) {
  // Real height: the text wraps to the width and may take more lines than el.h
  // assumes.
  const measure = document.createElement('canvas').getContext('2d')
  if (!measure) return
  measure.font = textFont(el)
  const lineCount = Math.max(1, wrapText(measure, el.text, el.w).length)
  const height = Math.max(el.h, lineCount * el.fontSize * TEXT_LINE_HEIGHT)
  const box = rotatedBox(el.x, el.y, el.w, height, el.rotation, 6)
  addRaster(pdf, box, 3, (ctx) => drawElement(ctx, { ...el, h: height, opacity: 1 }), el.opacity)
}

/** An image goes in as is when upright, and through a canvas when rotated. */
function drawImagePdf(pdf: jsPDF, el: ImageElement) {
  if (!el.rotation) {
    const format = el.src.startsWith('data:image/png') ? 'PNG' : 'JPEG'
    setOpacity(pdf, el.opacity)
    pdf.addImage(el.src, format, el.x, el.y, el.w, el.h, undefined, 'FAST')
    return
  }
  // Match the canvas resolution to the source so sharpness is not lost.
  const scale = Math.min(3, Math.max(1, el.naturalW / Math.max(1, el.w)))
  const box = rotatedBox(el.x, el.y, el.w, el.h, el.rotation, 2)
  addRaster(pdf, box, scale, (ctx) => drawElement(ctx, { ...el, opacity: 1 }), el.opacity)
}

/**
 * The sheet itself: tint, optional grain and the ruling inside the margins.
 *
 * With grain switched on the tint and the grain go in as one image. Every page
 * reuses it through a fixed alias, so the file carries a single copy no matter
 * how many sheets it holds.
 */
function drawPaperPdf(pdf: jsPDF, paper: PaperSettings, theme: Theme) {
  const look = lookOf(paper, theme)
  setOpacity(pdf, 1)

  if (paper.texture) {
    pdf.addImage(grainBackground(paper, theme), 'JPEG', 0, 0, BOARD_W, BOARD_H, GRAIN_ALIAS, 'FAST')
  } else {
    const paint = parseColor(look.paper)
    pdf.setFillColor(paint.r, paint.g, paint.b)
    pdf.rect(0, 0, BOARD_W, BOARD_H, 'F')
  }

  if (paper.ruling === 'blank') return

  const area = rulingArea(paper)
  const step = Math.max(2, paper.rulingMm) * MM
  const rule = parseColor(look.ruling)
  pdf.setDrawColor(rule.r, rule.g, rule.b)
  pdf.setFillColor(rule.r, rule.g, rule.b)
  pdf.setLineWidth(0.2 * MM)

  if (paper.ruling === 'grid') {
    for (let x = area.x + step; x < area.x + area.w; x += step) {
      pdf.line(x, area.y, x, area.y + area.h)
    }
    for (let y = area.y + step; y < area.y + area.h; y += step) {
      pdf.line(area.x, y, area.x + area.w, y)
    }
  } else if (paper.ruling === 'lines') {
    for (let y = area.y + step; y < area.y + area.h; y += step) {
      pdf.line(area.x, y, area.x + area.w, y)
    }
  } else {
    const r = Math.max(0.35, step * 0.075)
    for (let x = area.x + step; x < area.x + area.w; x += step) {
      for (let y = area.y + step; y < area.y + area.h; y += step) {
        pdf.circle(x, y, r, 'F')
      }
    }
  }

  if (paper.marginMm > 0) {
    const frame = parseColor(look.frame)
    pdf.setDrawColor(frame.r, frame.g, frame.b)
    pdf.setLineWidth(0.3 * MM)
    pdf.rect(area.x, area.y, area.w, area.h, 'S')
  }
}

const GRAIN_ALIAS = 'paper-grain'
/** Around 100 dpi: fine enough for grain, small enough for the file. */
const GRAIN_DPI_SCALE = 1.05
let grainCache: { key: string; data: string } | null = null

/** Tint plus grain baked into one page-sized JPEG. */
function grainBackground(paper: PaperSettings, theme: Theme): string {
  const key = `${paper.tint}:${theme}`
  if (grainCache?.key === key) return grainCache.data

  const look = lookOf(paper, theme)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(BOARD_W * GRAIN_DPI_SCALE)
  canvas.height = Math.round(BOARD_H * GRAIN_DPI_SCALE)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = look.paper
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const pattern = ctx.createPattern(makeGrainTile(), 'repeat')
  if (pattern) {
    ctx.fillStyle = pattern
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }
  const data = canvas.toDataURL('image/jpeg', 0.82)
  grainCache = { key, data }
  return data
}

export interface PdfOptions {
  /** How the paper looks. Defaults to the standard sheet. */
  paper?: PaperSettings
  /** Export only these page ids. All pages by default. */
  pageIds?: string[]
  theme?: Theme
  fileName?: string
  /** Raster mode: the whole page as an image, for maximum fidelity. */
  raster?: boolean
}

/** Rasterises a page: an exact copy of what is on screen. */
function renderPageToCanvas(
  doc: BoardDoc,
  pageId: string,
  theme: Theme,
  scale: number,
  paper: PaperSettings,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = BOARD_W * scale
  canvas.height = BOARD_H * scale
  const ctx = canvas.getContext('2d')!
  ctx.scale(scale, scale)
  drawPageBackground(ctx, paper, theme, 1 / scale)
  for (const el of pageElements(doc, pageId)) drawElement(ctx, el)
  return canvas
}

/** Builds the PDF document. Kept separate so it can be tested without a browser. */
export function buildPdf(doc: BoardDoc, opts: PdfOptions = {}): jsPDF | null {
  const theme = opts.theme ?? 'light'
  const paper = opts.paper ?? DEFAULT_PAPER
  // Explicitly chosen pages are exported as they are; that is a deliberate
  // choice. When exporting the whole board, empty pages are skipped: there is
  // always a spare sheet at the bottom and it does not belong in the file.
  let ids: string[]
  if (opts.pageIds?.length) {
    ids = doc.pages.filter((p) => opts.pageIds!.includes(p.id)).map((p) => p.id)
  } else {
    ids = doc.pages.filter((p) => !pageIsEmpty(doc, p.id)).map((p) => p.id)
    if (!ids.length && doc.pages.length) ids = [doc.pages[0].id]
  }
  if (!ids.length) return null

  // By default jsPDF counts a pixel as 4/3 of a point, which makes the page
  // half again larger than A4. The "px_scaling" hotfix turns it into 3/4, so
  // 794x1123 becomes exactly A4 — viewers and printers see the right format,
  // and board units map one to one onto PDF coordinates.
  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'px',
    format: [BOARD_W, BOARD_H],
    compress: true,
    hotfixes: ['px_scaling'],
  })

  ids.forEach((pageId, i) => {
    if (i > 0) pdf.addPage([BOARD_W, BOARD_H], 'portrait')
    if (opts.raster) {
      const canvas = renderPageToCanvas(doc, pageId, theme, 2, paper)
      pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, BOARD_W, BOARD_H)
      return
    }

    drawPaperPdf(pdf, paper, theme)
    for (const el of pageElements(doc, pageId)) {
      switch (el.type) {
        case 'stroke':
          drawStrokePdf(pdf, el)
          break
        case 'shape':
          drawShapePdf(pdf, el)
          break
        case 'text':
          drawTextPdf(pdf, el)
          break
        case 'image':
          drawImagePdf(pdf, el)
          break
      }
    }
  })

  setOpacity(pdf, 1)
  return pdf
}

/** Images must be decoded before drawing, or blank gaps end up in the file. */
async function awaitImages(doc: BoardDoc) {
  const srcs = Object.values(doc.elements)
    .filter((el): el is ImageElement => el.type === 'image')
    .map((el) => el.src)
  if (srcs.length) await preloadImages(srcs)
}

export async function exportPdf(doc: BoardDoc, opts: PdfOptions = {}): Promise<void> {
  await awaitImages(doc)
  const pdf = buildPdf(doc, opts)
  pdf?.save(opts.fileName ?? `board-${new Date().toISOString().slice(0, 10)}.pdf`)
}

/** Exports the current page as a PNG. */
export async function exportPng(
  doc: BoardDoc,
  pageId: string,
  theme: Theme,
  scale = 2,
  fileName?: string,
  paper: PaperSettings = DEFAULT_PAPER,
) {
  await awaitImages(doc)
  const canvas = renderPageToCanvas(doc, pageId, theme, scale, paper)
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
  if (!blob) return
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName ?? `board-${new Date().toISOString().slice(0, 10)}.png`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
