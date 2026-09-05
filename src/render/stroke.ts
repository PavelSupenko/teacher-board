import { getStroke } from 'perfect-freehand'
import type { BrushKind, LiveStroke, StrokeElement } from '../model/types'

export interface StrokeStyle {
  brush: BrushKind
  size: number
  simulated: boolean
}

/**
 * perfect-freehand options.
 *
 * Pen: clear thinning from pressure and a slight taper at the ends, so the line
 * looks written rather than plotted.
 * Highlighter: constant width and flat caps, like a real marker.
 *
 * Note that perfect-freehand treats `size` as a radius, so the pen passes half
 * of it. That keeps `style.size` meaning the same thing everywhere — the actual
 * line width at full pressure, in board units — which is what bounds, hit
 * testing and export assume. The highlighter has thinning = 0, where the width
 * equals `size` without halving.
 */
/** Length of a stroke in board units. */
export function strokeLength(flat: number[]): number {
  let len = 0
  for (let i = 3; i < flat.length; i += 3) {
    len += Math.hypot(flat[i] - flat[i - 3], flat[i + 1] - flat[i - 2])
  }
  return len
}

/**
 * @param length stroke length: for a short tap the taper is shortened, or it
 * would eat the whole stroke and no dot would be drawn at all.
 */
export function strokeOptions(style: StrokeStyle, done: boolean, length = Infinity) {
  if (style.brush === 'highlighter') {
    return {
      size: style.size,
      thinning: 0,
      smoothing: 0.6,
      streamline: 0.5,
      simulatePressure: false,
      last: done,
      start: { cap: false, taper: 0 },
      end: { cap: false, taper: 0 },
    }
  }
  return {
    size: style.size / 2,
    thinning: style.simulated ? 0.45 : 0.62,
    smoothing: 0.52,
    streamline: style.simulated ? 0.5 : 0.38,
    simulatePressure: style.simulated,
    easing: (t: number) => Math.sin((t * Math.PI) / 2),
    last: done,
    start: { cap: true, taper: style.simulated ? 0 : Math.min(style.size * 0.9, length * 0.22) },
    end: { cap: true, taper: style.simulated ? 0 : Math.min(style.size * 1.4, length * 0.3) },
  }
}

/** Flat [x, y, p, …] array into the shape perfect-freehand expects. */
export function unpackPoints(flat: number[]): number[][] {
  const out: number[][] = new Array(flat.length / 3)
  for (let i = 0, j = 0; i < flat.length; i += 3, j++) {
    out[j] = [flat[i], flat[i + 1], flat[i + 2]]
  }
  return out
}

/**
 * A touch shorter than this counts as a dot. A pen always trembles a little,
 * and without such a threshold a stroke a couple of units long collapses into
 * an outline of zero size — nothing shows up on the board. The highlighter has
 * no taper, so short strokes there draw fine on their own.
 */
const dotThreshold = (style: StrokeStyle) =>
  style.brush === 'highlighter' ? 2 : Math.max(4, style.size * 1.2)

/** Reduces a short touch to one point: the middle of the trace, peak pressure. */
function asDot(points: number[][]): number[][] {
  let x = 0
  let y = 0
  let p = 0
  for (const pt of points) {
    x += pt[0]
    y += pt[1]
    p = Math.max(p, pt[2])
  }
  const dot = [x / points.length, y / points.length, p]
  // perfect-freehand draws two coinciding points as a round blob; a single
  // point yields an outline of zero size.
  return [dot, [...dot]]
}

/**
 * Adds intermediate points to short strokes. With only two or three input
 * points perfect-freehand has nothing to smooth and the outline degenerates
 * into a segment of zero thickness, leaving the stroke invisible.
 */
function densify(points: number[][], minCount: number): number[][] {
  if (points.length >= minCount) return points
  const out: number[][] = [points[0]]
  const perSegment = Math.ceil((minCount - 1) / (points.length - 1))
  for (let i = 1; i < points.length; i++) {
    const [x0, y0, p0] = points[i - 1]
    const [x1, y1, p1] = points[i]
    for (let k = 1; k <= perSegment; k++) {
      const t = k / perSegment
      out.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, p0 + (p1 - p0) * t])
    }
  }
  return out
}

export function outlinePoints(
  flat: number[],
  style: StrokeStyle,
  done = true,
): number[][] {
  if (flat.length < 3) return []
  const length = strokeLength(flat)
  const raw = unpackPoints(flat)
  const points =
    raw.length === 1
      ? asDot(raw)
      : length < dotThreshold(style)
        ? asDot(raw)
        : densify(raw, 6)
  return getStroke(points, strokeOptions(style, done, length)) as number[][]
}

/**
 * The closed stroke outline as a Path2D. Corners are smoothed with quadratic
 * curves through edge midpoints, which removes faceting at high zoom.
 */
export function outlineToPath(outline: number[][]): Path2D {
  const path = new Path2D()
  const n = outline.length
  if (n < 2) return path
  if (n < 4) {
    path.moveTo(outline[0][0], outline[0][1])
    for (let i = 1; i < n; i++) path.lineTo(outline[i][0], outline[i][1])
    path.closePath()
    return path
  }
  let [x0, y0] = outline[0]
  let [x1, y1] = outline[1]
  path.moveTo((x0 + x1) / 2, (y0 + y1) / 2)
  for (let i = 1; i < n; i++) {
    ;[x0, y0] = outline[i]
    ;[x1, y1] = outline[(i + 1) % n]
    path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2)
  }
  path.closePath()
  return path
}

interface PathCacheEntry {
  points: number[]
  size: number
  path: Path2D
}

const pathCache = new WeakMap<StrokeElement, PathCacheEntry>()

export function strokePath(el: StrokeElement): Path2D {
  const cached = pathCache.get(el)
  if (cached && cached.points === el.points && cached.size === el.size) return cached.path
  const path = outlineToPath(outlinePoints(el.points, el, true))
  pathCache.set(el, { points: el.points, size: el.size, path })
  return path
}

export function livePath(live: LiveStroke, done = false): Path2D {
  return outlineToPath(outlinePoints(live.points, live, done))
}
