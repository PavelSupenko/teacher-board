import type { BoardElement, ShapeElement, ShapeKind, StrokeElement } from './types'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const rotatePoint = (
  px: number,
  py: number,
  cx: number,
  cy: number,
  angle: number,
): [number, number] => {
  if (!angle) return [px, py]
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const dx = px - cx
  const dy = py - cy
  return [cx + dx * c - dy * s, cy + dx * s + dy * c]
}

/** Maps a point into an element's own, unrotated coordinates. */
export const toLocal = (el: BoardElement, px: number, py: number): [number, number] => {
  if (el.type === 'stroke') return [px, py]
  const cx = el.x + el.w / 2
  const cy = el.y + el.h / 2
  return rotatePoint(px, py, cx, cy, -el.rotation)
}

/* ------------------------------------------------------------------ */
/* Shape outlines: one source of truth for drawing, PDF and hit testing.  */
/* ------------------------------------------------------------------ */

/** Shape vertices in local coordinates. `closed: false` means an open path. */
export function shapePoints(
  shape: ShapeKind,
  x: number,
  y: number,
  w: number,
  h: number,
): { pts: [number, number][]; closed: boolean } | null {
  const x2 = x + w
  const y2 = y + h
  switch (shape) {
    case 'line':
      return { pts: [[x, y], [x2, y2]], closed: false }
    case 'rect':
      return { pts: [[x, y], [x2, y], [x2, y2], [x, y2]], closed: true }
    case 'triangle':
      return { pts: [[x + w / 2, y], [x2, y2], [x, y2]], closed: true }
    case 'diamond':
      return {
        pts: [[x + w / 2, y], [x2, y + h / 2], [x + w / 2, y2], [x, y + h / 2]],
        closed: true,
      }
    case 'star': {
      const cx = x + w / 2
      const cy = y + h / 2
      const rx = w / 2
      const ry = h / 2
      const pts: [number, number][] = []
      for (let i = 0; i < 10; i++) {
        const k = i % 2 === 0 ? 1 : 0.42
        const a = -Math.PI / 2 + (i * Math.PI) / 5
        pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k])
      }
      return { pts, closed: true }
    }
    case 'arrow': {
      // The arrow body is a segment; the head is computed separately.
      return { pts: [[x, y], [x2, y2]], closed: false }
    }
    case 'ellipse':
      return null // an ellipse is drawn as an arc, not a polygon
  }
}

/** The two side lines of an arrow head, in local coordinates. */
export function arrowHead(
  x: number,
  y: number,
  w: number,
  h: number,
  size: number,
): [number, number][][] {
  const x2 = x + w
  const y2 = y + h
  const len = Math.hypot(w, h)
  if (len < 1) return []
  const head = Math.min(len * 0.35, 14 + size * 2.4)
  const a = Math.atan2(h, w)
  const spread = 0.45
  return [
    [[x2, y2], [x2 - head * Math.cos(a - spread), y2 - head * Math.sin(a - spread)]],
    [[x2, y2], [x2 - head * Math.cos(a + spread), y2 - head * Math.sin(a + spread)]],
  ]
}

/** An ellipse as a polygon, for hit testing and PDF where one path is needed. */
export function ellipsePoints(
  x: number,
  y: number,
  w: number,
  h: number,
  steps = 48,
): [number, number][] {
  const cx = x + w / 2
  const cy = y + h / 2
  const rx = Math.abs(w) / 2
  const ry = Math.abs(h) / 2
  const pts: [number, number][] = []
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2
    pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry])
  }
  return pts
}

/* ------------------------------------------------------------------ */
/* Bounds                                                              */
/* ------------------------------------------------------------------ */

interface BoundsCacheEntry {
  points: number[]
  size: number
  rect: Rect
}

// Keyed by the element itself, but an entry is valid only while its points
// array is unchanged — transformations always store a new array.
const strokeBoundsCache = new WeakMap<StrokeElement, BoundsCacheEntry>()

export function strokeBounds(el: StrokeElement): Rect {
  const cached = strokeBoundsCache.get(el)
  if (cached && cached.points === el.points && cached.size === el.size) return cached.rect
  const p = el.points
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < minX) minX = p[i]
    if (p[i] > maxX) maxX = p[i]
    if (p[i + 1] < minY) minY = p[i + 1]
    if (p[i + 1] > maxY) maxY = p[i + 1]
  }
  if (!isFinite(minX)) {
    const empty = { x: 0, y: 0, w: 0, h: 0 }
    strokeBoundsCache.set(el, { points: el.points, size: el.size, rect: empty })
    return empty
  }
  const pad = el.size / 2
  const r: Rect = {
    x: minX - pad,
    y: minY - pad,
    w: maxX - minX + pad * 2,
    h: maxY - minY + pad * 2,
  }
  strokeBoundsCache.set(el, { points: el.points, size: el.size, rect: r })
  return r
}

/** Bounds ignoring rotation, in the element's own coordinates. */
export function localBounds(el: BoardElement): Rect {
  if (el.type === 'stroke') return strokeBounds(el)
  return { x: el.x, y: el.y, w: el.w, h: el.h }
}

/** Bounds in page coordinates: the box enclosing the rotated element. */
export function worldBounds(el: BoardElement): Rect {
  const b = localBounds(el)
  if (el.type === 'stroke' || !el.rotation) return b
  const cx = b.x + b.w / 2
  const cy = b.y + b.h / 2
  const corners: [number, number][] = [
    [b.x, b.y],
    [b.x + b.w, b.y],
    [b.x + b.w, b.y + b.h],
    [b.x, b.y + b.h],
  ].map(([px, py]) => rotatePoint(px, py, cx, cy, el.rotation)) as [number, number][]
  const xs = corners.map((c) => c[0])
  const ys = corners.map((c) => c[1])
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY }
}

export function unionBounds(els: BoardElement[]): Rect | null {
  if (!els.length) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const el of els) {
    const b = worldBounds(el)
    minX = Math.min(minX, b.x)
    minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.w)
    maxY = Math.max(maxY, b.y + b.h)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export const rectsIntersect = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

export const pointInRect = (px: number, py: number, r: Rect): boolean =>
  px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h

/* ------------------------------------------------------------------ */
/* Hit testing                                                         */
/* ------------------------------------------------------------------ */

function distToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

function distToPolyline(px: number, py: number, pts: [number, number][], closed: boolean): number {
  let best = Infinity
  const n = pts.length
  const last = closed ? n : n - 1
  for (let i = 0; i < last; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % n]
    best = Math.min(best, distToSegment(px, py, a[0], a[1], b[0], b[1]))
    if (best === 0) break
  }
  return best
}

function pointInPolygon(px: number, py: number, pts: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]
    const [xj, yj] = pts[j]
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function shapeOutline(el: ShapeElement): { pts: [number, number][]; closed: boolean } {
  if (el.shape === 'ellipse') {
    return { pts: ellipsePoints(el.x, el.y, el.w, el.h), closed: true }
  }
  const p = shapePoints(el.shape, el.x, el.y, el.w, el.h)
  return p ?? { pts: [], closed: false }
}

/** Whether a point hits an element. `tol` is the slack in board units. */
export function hitTest(el: BoardElement, wx: number, wy: number, tol = 6): boolean {
  const [px, py] = toLocal(el, wx, wy)

  if (el.type === 'stroke') {
    const b = strokeBounds(el)
    if (!pointInRect(px, py, { x: b.x - tol, y: b.y - tol, w: b.w + tol * 2, h: b.h + tol * 2 })) {
      return false
    }
    const r = el.size / 2 + tol
    const p = el.points
    if (p.length === 3) return Math.hypot(px - p[0], py - p[1]) <= r
    for (let i = 0; i + 5 < p.length; i += 3) {
      if (distToSegment(px, py, p[i], p[i + 1], p[i + 3], p[i + 4]) <= r) return true
    }
    return false
  }

  if (el.type === 'text' || el.type === 'image') {
    return pointInRect(px, py, { x: el.x, y: el.y, w: el.w, h: el.h })
  }

  const { pts, closed } = shapeOutline(el)
  if (!pts.length) return false
  if (el.fill && closed && pointInPolygon(px, py, pts)) return true
  return distToPolyline(px, py, pts, closed) <= el.size / 2 + tol
}

/** Whether an element lies entirely inside a marquee rectangle. */
export function elementInRect(el: BoardElement, r: Rect): boolean {
  const b = worldBounds(el)
  return b.x >= r.x && b.y >= r.y && b.x + b.w <= r.x + r.w && b.y + b.h <= r.y + r.h
}

/** Whether a segment — an eraser move — crosses an element. */
export function strokeIntersects(
  el: BoardElement,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  tol: number,
): boolean {
  const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / Math.max(2, tol)))
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    if (hitTest(el, ax + (bx - ax) * t, ay + (by - ay) * t, tol)) return true
  }
  return false
}

/* ------------------------------------------------------------------ */
/* Transform handles                                                   */
/* ------------------------------------------------------------------ */

export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rotate'

export const HANDLE_ORDER: HandleId[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

export function handlePositions(r: Rect, rotation = 0): Record<HandleId, [number, number]> {
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  const raw: Record<HandleId, [number, number]> = {
    nw: [r.x, r.y],
    n: [cx, r.y],
    ne: [r.x + r.w, r.y],
    e: [r.x + r.w, cy],
    se: [r.x + r.w, r.y + r.h],
    s: [cx, r.y + r.h],
    sw: [r.x, r.y + r.h],
    w: [r.x, cy],
    rotate: [cx, r.y - 34],
  }
  if (!rotation) return raw
  const out = {} as Record<HandleId, [number, number]>
  for (const k of Object.keys(raw) as HandleId[]) {
    out[k] = rotatePoint(raw[k][0], raw[k][1], cx, cy, rotation)
  }
  return out
}

export const HANDLE_CURSOR: Record<HandleId, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  rotate: 'grab',
}
