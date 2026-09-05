import { rotatePoint, type HandleId, type Rect } from '../model/geometry'
import type { BoardElement } from '../model/types'

export type Patch = Record<string, unknown>

/** Normalises negative sizes left behind by a flip. */
function normalizeRect(p: Patch) {
  const x = p.x as number
  const y = p.y as number
  const w = p.w as number
  const h = p.h as number
  if (w < 0) {
    p.x = x + w
    p.w = -w
  }
  if (h < 0) {
    p.y = y + h
    p.h = -h
  }
}

export interface ResizeResult {
  patches: Map<string, Patch>
}

/**
 * Resizes the selection by one of its handles.
 * `dx`/`dy` is the pointer offset in the same coordinates as `bounds` — for a
 * single rotated element, in that element's own frame.
 */
export function resizeElements(
  els: BoardElement[],
  bounds: Rect,
  handle: HandleId,
  dx: number,
  dy: number,
  keepAspect: boolean,
): ResizeResult {
  const MIN = 4
  const left = handle.includes('w')
  const right = handle.includes('e')
  const top = handle.startsWith('n')
  const bottom = handle.startsWith('s')

  let newW = bounds.w + (right ? dx : left ? -dx : 0)
  let newH = bounds.h + (bottom ? dy : top ? -dy : 0)
  if (right || left) newW = Math.abs(newW) < MIN ? Math.sign(newW || 1) * MIN : newW
  if (top || bottom) newH = Math.abs(newH) < MIN ? Math.sign(newH || 1) * MIN : newH

  let sx = right || left ? newW / bounds.w : 1
  let sy = top || bottom ? newH / bounds.h : 1

  if (keepAspect && (right || left) && (top || bottom)) {
    const k = Math.max(Math.abs(sx), Math.abs(sy))
    sx = Math.sign(sx) * k
    sy = Math.sign(sy) * k
  } else if (keepAspect) {
    if (right || left) sy = sx
    else sx = sy
  }

  const anchorX = left ? bounds.x + bounds.w : bounds.x
  const anchorY = top ? bounds.y + bounds.h : bounds.y
  const sizeScale = Math.sqrt(Math.abs(sx * sy)) || 1

  const patches = new Map<string, Patch>()
  for (const el of els) {
    if (el.type === 'stroke') {
      const pts = el.points.slice()
      for (let i = 0; i < pts.length; i += 3) {
        pts[i] = anchorX + (pts[i] - anchorX) * sx
        pts[i + 1] = anchorY + (pts[i + 1] - anchorY) * sy
      }
      patches.set(el.id, { points: pts, size: Math.max(0.5, el.size * sizeScale) })
      continue
    }
    const p: Patch = {
      x: anchorX + (el.x - anchorX) * sx,
      y: anchorY + (el.y - anchorY) * sy,
      w: el.w * sx,
      h: el.h * sy,
    }
    normalizeRect(p)
    if (el.type === 'text') {
      p.fontSize = Math.max(6, el.fontSize * sizeScale)
    } else if (el.type === 'shape') {
      p.size = Math.max(0, el.size * sizeScale)
    }
    // An image has nothing else to scale: it is just a rectangle.
    patches.set(el.id, p)
  }
  return { patches }
}

/** Rotates the selection around a point. */
export function rotateElements(
  els: BoardElement[],
  cx: number,
  cy: number,
  delta: number,
): Map<string, Patch> {
  const patches = new Map<string, Patch>()
  for (const el of els) {
    if (el.type === 'stroke') {
      const pts = el.points.slice()
      for (let i = 0; i < pts.length; i += 3) {
        const [x, y] = rotatePoint(pts[i], pts[i + 1], cx, cy, delta)
        pts[i] = x
        pts[i + 1] = y
      }
      patches.set(el.id, { points: pts })
      continue
    }
    const ecx = el.x + el.w / 2
    const ecy = el.y + el.h / 2
    const [nx, ny] = rotatePoint(ecx, ecy, cx, cy, delta)
    patches.set(el.id, {
      x: el.x + (nx - ecx),
      y: el.y + (ny - ecy),
      rotation: el.rotation + delta,
    })
  }
  return patches
}

/** Moves the selection. */
export function moveElements(els: BoardElement[], dx: number, dy: number): Map<string, Patch> {
  const patches = new Map<string, Patch>()
  for (const el of els) {
    if (el.type === 'stroke') {
      const pts = el.points.slice()
      for (let i = 0; i < pts.length; i += 3) {
        pts[i] += dx
        pts[i + 1] += dy
      }
      patches.set(el.id, { points: pts })
    } else {
      patches.set(el.id, { x: el.x + dx, y: el.y + dy })
    }
  }
  return patches
}

/** Field values before a change, kept for the undo step. */
export function snapshotFields(el: BoardElement, patch: Patch): Patch {
  const out: Patch = {}
  for (const k of Object.keys(patch)) {
    const v = (el as unknown as Record<string, unknown>)[k]
    out[k] = Array.isArray(v) ? [...v] : v
  }
  return out
}
