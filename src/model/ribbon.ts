import { BOARD_H, MM } from './types'

/**
 * Pages are laid out one below another as a continuous ribbon.
 *
 * Element coordinates stay local to their page, so the document does not depend
 * on the order of sheets and neither export nor syncing has to change. The
 * ribbon exists only on screen: while drawing and while handling input, a
 * page's offset is added to its coordinates.
 */
export const PAGE_GAP = Math.round(12 * MM)
export const PAGE_STRIDE = BOARD_H + PAGE_GAP

/** Vertical offset of a page in ribbon coordinates. */
export const pageTop = (index: number): number => index * PAGE_STRIDE

/** Height of the whole ribbon, without the trailing gap. */
export const ribbonHeight = (pageCount: number): number =>
  Math.max(BOARD_H, pageCount * PAGE_STRIDE - PAGE_GAP)

/** Index of the page under a ribbon point; in a gap, the one above. */
export function pageIndexAt(pageCount: number, y: number): number {
  if (pageCount <= 0) return 0
  return Math.max(0, Math.min(pageCount - 1, Math.floor(y / PAGE_STRIDE)))
}

/**
 * The page filling the viewport, which counts as the current one.
 * The probe sits a little above the middle so a sheet you have just scrolled
 * to becomes current before it covers the whole screen.
 */
export function visiblePageIndex(
  pageCount: number,
  viewTop: number,
  viewHeight: number,
): number {
  return pageIndexAt(pageCount, viewTop + viewHeight * 0.35)
}
