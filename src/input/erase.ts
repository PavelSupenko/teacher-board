import type { StrokeElement } from '../model/types'

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

/**
 * Cuts out the part of a stroke the eraser was dragged over.
 *
 * Returns the surviving pieces, each a flat [x, y, pressure, …] array. An empty
 * array means nothing is left of the stroke; `null` means the eraser missed it
 * and the element should be left alone.
 *
 * Single-point leftovers are dropped: after a cut they would look like crumbs
 * along the edge.
 */
export function erasePartOfStroke(
  el: StrokeElement,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  radius: number,
): number[][] | null {
  const p = el.points
  const count = Math.floor(p.length / 3)
  if (count === 0) return null

  const runs: number[][] = []
  let current: number[] = []
  let erased = false

  for (let i = 0; i < count; i++) {
    const x = p[i * 3]
    const y = p[i * 3 + 1]
    if (distToSegment(x, y, ax, ay, bx, by) <= radius) {
      erased = true
      if (current.length) {
        runs.push(current)
        current = []
      }
    } else {
      current.push(x, y, p[i * 3 + 2])
    }
  }
  if (current.length) runs.push(current)
  if (!erased) return null

  return runs.filter((run) => run.length >= 6)
}
