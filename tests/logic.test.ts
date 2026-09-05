/**
 * Client-side logic without a browser: history, geometry, strokes, PDF.
 * Run with: npm test
 */
import { BoardStore } from '../src/model/store'
import { applyOp, createDoc } from '../shared/doc.js'
import {
  hitTest,
  strokeBounds,
  unionBounds,
  elementInRect,
  strokeIntersects,
  handlePositions,
  worldBounds,
} from '../src/model/geometry'
import { moveElements, resizeElements, rotateElements } from '../src/input/transform'
import { outlinePoints } from '../src/render/stroke'
import { pageIsEmpty, trailingPageOp } from '../shared/doc.js'
import { BOARD_H, BOARD_W, DEFAULT_PAPER, MM } from '../src/model/types'
import { PAPER_LOOKS, rulingArea } from '../src/render/paper'
import {
  PAGE_STRIDE,
  pageIndexAt,
  pageTop,
  ribbonHeight,
  visiblePageIndex,
} from '../src/model/ribbon'
import { buildPdf, parseColor } from '../src/export/pdf'
import { erasePartOfStroke } from '../src/input/erase'
import { fitOnPage } from '../src/input/media'
import {
  FORCE_MAX,
  FORCE_MIN,
  FORCE_TOUCH_SUPPORTED,
  forceToPressure,
  trackForceTouch,
} from '../src/input/forceTouch'
import { inflateSync } from 'node:zlib'
import type { BoardElement, ShapeElement, StrokeElement } from '../src/model/types'

/** Inflates PDF content streams so the drawn output can be inspected. */
function inflateStreams(latin1: string): string {
  const buf = Buffer.from(latin1, 'latin1')
  let out = ''
  let i = 0
  while ((i = buf.indexOf('stream', i)) !== -1) {
    let s = i + 6
    while (buf[s] === 0x0d || buf[s] === 0x0a) s++
    const e = buf.indexOf('endstream', s)
    if (e === -1) break
    try {
      out += inflateSync(buf.subarray(s, e)).toString('latin1') + '\n'
    } catch {
      /* not a compressed or textual stream */
    }
    i = e
  }
  return out
}

let failures = 0
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`)
  if (!ok) failures++
}
const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) < eps

const PAGE = 'p1'
const mkStroke = (id: string, pts: number[], size = 6): StrokeElement => ({
  id,
  type: 'stroke',
  pageId: PAGE,
  authorId: 'u1',
  createdAt: 1,
  brush: 'pen',
  points: pts,
  color: '#111827',
  size,
  opacity: 1,
  simulated: false,
})

const mkShape = (id: string, over: Partial<ShapeElement> = {}): ShapeElement => ({
  id,
  type: 'shape',
  pageId: PAGE,
  authorId: 'u1',
  createdAt: 1,
  shape: 'rect',
  x: 100,
  y: 100,
  w: 200,
  h: 100,
  rotation: 0,
  color: '#111827',
  fill: null,
  size: 4,
  opacity: 1,
  ...over,
})

/* ---------------- history ---------------- */
{
  const store = new BoardStore()
  const sent: string[] = []
  store.onOp = (op) => sent.push(op.t)

  store.commit({ t: 'add', el: mkStroke('a', [0, 0, 0.5, 50, 50, 0.5]) })
  store.commit({ t: 'add', el: mkShape('b') })
  check(store.doc.order.length === 2, 'two elements were added')
  check(sent.length === 2, 'the operations went out to the network')

  store.undo()
  check(!store.doc.elements.b && !!store.doc.elements.a, 'undo removes the last element')
  store.redo()
  check(!!store.doc.elements.b, 'redo brings the element back')

  // The z-order must be restored when a deletion is undone
  store.commit({ t: 'add', el: mkShape('c') })
  store.commit({ t: 'remove', ids: ['b'] })
  check(store.doc.order.join() === 'a,c', 'deleting cuts the element out of the order')
  store.undo()
  check(store.doc.order.join() === 'a,b,c', 'undoing a deletion restores the z-order')

  // changing properties
  store.commit({ t: 'update', id: 'b', patch: { color: '#ff0000' } })
  check((store.doc.elements.b as ShapeElement).color === '#ff0000', 'the color changed')
  store.undo()
  check((store.doc.elements.b as ShapeElement).color === '#111827', 'undo brings the previous color back')

  // a transaction is one undo step
  const before = store.doc.order.length
  store.transaction(() => {
    store.commit({ t: 'add', el: mkShape('d') })
    store.commit({ t: 'add', el: mkShape('e') })
  })
  check(store.doc.order.length === before + 2, 'the transaction added two elements')
  store.undo()
  check(store.doc.order.length === before, 'the transaction is undone as a whole')

  // clearing a page and undoing it
  store.commit({ t: 'clearPage', pageId: PAGE })
  check(store.doc.order.length === 0, 'the page was cleared')
  store.undo()
  check(store.doc.order.join() === 'a,b,c', 'undoing a clear brings all content back')

  // deleting a page together with its content
  const doc2 = createDoc('p1')
  const s2 = new BoardStore()
  s2.replace(doc2)
  s2.commit({ t: 'addPage', page: { id: 'p2', name: '2' }, index: 1 })
  s2.commit({ t: 'add', el: { ...mkShape('z'), pageId: 'p2' } })
  s2.commit({ t: 'removePage', pageId: 'p2' })
  check(s2.doc.pages.length === 1 && !s2.doc.elements.z, 'the page was deleted along with its elements')
  s2.undo()
  check(s2.doc.pages.length === 2 && !!s2.doc.elements.z, 'undo restores the page and its elements')
}

/* ---------------- geometry ---------------- */
{
  const st = mkStroke('s', [0, 0, 0.5, 100, 0, 0.5], 10)
  check(hitTest(st, 50, 0, 0), 'a point on a stroke is recognised')
  check(!hitTest(st, 50, 60, 0), 'a point away from a stroke is not')
  const b = strokeBounds(st)
  check(near(b.x, -5) && near(b.w, 110), 'stroke bounds account for thickness')

  // The bounds cache must refresh when the points change
  st.points = [0, 0, 0.5, 200, 0, 0.5]
  check(near(strokeBounds(st).w, 210), 'bounds are recomputed after the points change')

  const rect = mkShape('r', { fill: null })
  check(hitTest(rect, 100, 100, 3), 'a click on a rectangle outline')
  check(!hitTest(rect, 200, 150, 3), 'a click inside an unfilled shape does not count')
  check(hitTest({ ...rect, fill: '#fff' }, 200, 150, 3), 'a click inside a filled shape does count')

  // A 200x100 rectangle centred at (200,150) and rotated by 90 degrees:
  // its local corner (100,100) ends up at page point (250,50).
  const rotated = mkShape('rr', { rotation: Math.PI / 2 })
  check(hitTest(rotated, 250, 50, 6), 'hit testing accounts for rotation')
  check(!hitTest(rotated, 100, 100, 6), 'the unrotated corner no longer hits')

  const ell = mkShape('e', { shape: 'ellipse', x: 0, y: 0, w: 200, h: 100, fill: '#fff' })
  check(hitTest(ell, 100, 50, 2), 'the centre of an ellipse is inside')
  check(!hitTest(ell, 8, 8, 2), 'a corner of the bounding box is outside the ellipse')

  const u = unionBounds([mkShape('a1'), mkShape('a2', { x: 400, y: 300 })])!
  check(near(u.x, 100) && near(u.w, 500) && near(u.h, 300), 'bounds are combined')

  check(elementInRect(rect, { x: 0, y: 0, w: 500, h: 500 }), 'the element is inside the marquee')
  check(!elementInRect(rect, { x: 0, y: 0, w: 150, h: 500 }), 'a partially covered element is not selected')

  check(strokeIntersects(st, -10, 0, 300, 0, 5), 'the eraser crosses the stroke')
  check(!strokeIntersects(st, -10, 200, 300, 200, 5), 'the eraser misses the stroke')

  const hp = handlePositions({ x: 0, y: 0, w: 100, h: 100 }, 0)
  check(near(hp.se[0], 100) && near(hp.se[1], 100), 'the se handle sits at the bottom-right corner')
  check(hp.rotate[1] < 0, 'the rotate handle sits above the shape')
}

/* ---------------- transforms ---------------- */
{
  const shape = mkShape('m')
  const moved = moveElements([shape], 50, -20).get('m') as { x: number; y: number }
  check(near(moved.x, 150) && near(moved.y, 80), 'a shape moves')

  const st = mkStroke('ms', [0, 0, 0.5, 10, 10, 0.5])
  const movedPts = moveElements([st], 5, 5).get('ms') as { points: number[] }
  check(movedPts.points[0] === 5 && movedPts.points[4] === 15, 'stroke points move')

  const s = mkShape('rs', { x: 0, y: 0, w: 100, h: 100 })
  const r = resizeElements([s], { x: 0, y: 0, w: 100, h: 100 }, 'se', 100, 0, false)
    .patches.get('rs') as { w: number; h: number; x: number }
  check(near(r.w, 200) && near(r.h, 100), 'dragging a corner along one axis')

  const rA = resizeElements([s], { x: 0, y: 0, w: 100, h: 100 }, 'se', 100, 0, true)
    .patches.get('rs') as { w: number; h: number }
  check(near(rA.w, 200) && near(rA.h, 200), 'Shift keeps the aspect ratio')

  const rW = resizeElements([s], { x: 0, y: 0, w: 100, h: 100 }, 'w', 50, 0, false)
    .patches.get('rs') as { x: number; w: number }
  check(near(rW.x, 50) && near(rW.w, 50), 'dragging the left handle moves the left edge')

  const flipped = resizeElements([s], { x: 0, y: 0, w: 100, h: 100 }, 'e', -150, 0, false)
    .patches.get('rs') as { x: number; w: number }
  check(flipped.w > 0 && near(flipped.x, -50), 'a flip normalises negative width')

  const scaled = resizeElements([mkStroke('ss', [0, 0, 0.5, 100, 0, 0.5], 10)],
    { x: 0, y: 0, w: 100, h: 100 }, 'se', 100, 100, true)
    .patches.get('ss') as { points: number[]; size: number }
  check(near(scaled.size, 20), 'stroke thickness scales with the stroke')
  check(near(scaled.points[3], 200), 'stroke points scale')

  const rot = rotateElements([mkShape('ro', { x: 0, y: 0, w: 100, h: 100 })], 50, 50, Math.PI / 2)
    .get('ro') as { rotation: number; x: number }
  check(near(rot.rotation, Math.PI / 2) && near(rot.x, 0), 'rotation around its own centre')

  const rotSt = rotateElements([mkStroke('rst', [100, 0, 0.5, 100, 10, 0.5])], 0, 0, Math.PI / 2)
    .get('rst') as { points: number[] }
  check(near(rotSt.points[0], 0, 1e-6) && near(rotSt.points[1], 100), 'stroke points rotate')
}

/* ---------------- stroke smoothing ---------------- */
{
  // A realistic stroke: 41 points along a line, pressure peaking in the middle.
  const flat: number[] = []
  for (let i = 0; i <= 40; i++) {
    const t = i / 40
    flat.push(t * 200, 0, 0.15 + 0.85 * Math.sin(t * Math.PI))
  }

  const widthAt = (outline: number[][], x: number) => {
    const ys = outline.filter((p) => Math.abs(p[0] - x) < 8).map((p) => p[1])
    return ys.length ? Math.max(...ys) - Math.min(...ys) : 0
  }

  const pen = outlinePoints(flat, { brush: 'pen', size: 20, simulated: false }, true)
  check(pen.length > 30, `the stroke outline was built (${pen.length} points)`)
  check(widthAt(pen, 100) <= 20.5, 'thickness never exceeds the configured pen size')
  check(widthAt(pen, 100) > 14, 'at full pressure the line is close to its nominal thickness')

  // Compare two identical strokes drawn at constant light and heavy pressure.
  const constPressure = (p: number) =>
    flat.map((v, i) => (i % 3 === 2 ? p : v))
  const soft = outlinePoints(constPressure(0.15), { brush: 'pen', size: 20, simulated: false }, true)
  const hard = outlinePoints(constPressure(1), { brush: 'pen', size: 20, simulated: false }, true)
  check(
    widthAt(hard, 100) > widthAt(soft, 100) * 1.8,
    `heavy pressure gives a clearly wider line than light (${widthAt(soft, 100)} → ${widthAt(hard, 100)})`,
  )

  const hl = outlinePoints(flat, { brush: 'highlighter', size: 30, simulated: false }, true)
  check(
    Math.abs(widthAt(hl, 100) - widthAt(hl, 40)) < 1.5,
    'the highlighter keeps a constant width regardless of pressure',
  )
  check(near(widthAt(hl, 100), 30, 1.5), 'the highlighter width matches the setting')

  // Mouse: no pressure, yet the line must still look alive through speed.
  const mouse = outlinePoints(
    flat.map((v, i) => (i % 3 === 2 ? 0.5 : v)),
    { brush: 'pen', size: 20, simulated: true },
    true,
  )
  check(mouse.length > 30, 'a mouse stroke is built as well')

  // An unfinished stroke is shorter: the end taper is added when it completes.
  const partial = outlinePoints(flat, { brush: 'pen', size: 20, simulated: false }, false)
  check(partial.length > 10, 'an interim outline is built while drawing')
}

/* ---------------- dots and very short strokes ---------------- */
{
  // A pen tap must not be lost: the end taper has no right to eat the whole
  // stroke.
  const height = (o: number[][]) => {
    const ys = o.map((p) => p[1])
    return o.length ? Math.max(...ys) - Math.min(...ys) : 0
  }
  let invisible = 0
  for (const size of [2, 3, 5, 8, 14, 24, 40]) {
    for (const brush of ['pen', 'highlighter'] as const) {
      for (const len of [0, 0.4, 0.9, 1.6, 2.5, 3.5, 5, 7, 9, 13, 18, 25, 40, 80]) {
        // Points every 0.7 units, the way the canvas samples them.
        const pts: number[] = []
        const n = Math.max(1, Math.round(len / 0.7))
        for (let i = 0; i <= n; i++) pts.push(100 + (len * i) / n, 100, 0.55)
        if (height(outlinePoints(pts, { brush, size, simulated: false }, true)) < Math.min(1, size * 0.2)) {
          invisible++
        }
      }
    }
  }
  check(invisible === 0, `every touch leaves a mark (invisible cases: ${invisible})`)

  const tap = outlinePoints([100, 100, 0.7], { brush: 'pen', size: 8, simulated: false }, true)
  check(height(tap) > 4, `a single tap draws a dot (${height(tap).toFixed(1)})`)
  const softTap = outlinePoints([100, 100, 0.15], { brush: 'pen', size: 8, simulated: false }, true)
  check(height(softTap) < height(tap), 'a light tap gives a smaller dot than a firm one')

  // A long stroke must still taper towards its ends.
  const long: number[] = []
  for (let i = 0; i <= 120; i++) long.push(100 + i * 2, 100, 0.7)
  const o = outlinePoints(long, { brush: 'pen', size: 8, simulated: false }, true)
  const at = (x: number, win = 1.5) => {
    const ys = o.filter((p) => Math.abs(p[0] - x) < win).map((p) => p[1])
    return ys.length ? Math.max(...ys) - Math.min(...ys) : 0
  }
  check(at(101) < at(220, 6) * 0.5 && at(339) < at(220, 6) * 0.5, 'a long stroke still thins away at both ends')
}

/* ---------------- A4 format and the spare page ---------------- */
{
  check(near(BOARD_W / BOARD_H, 210 / 297, 0.002), `the sheet has A4 proportions (${BOARD_W}×${BOARD_H})`)
  check(BOARD_H > BOARD_W, 'the orientation is portrait')
  check(near(MM * 210, BOARD_W), 'millimetres convert to board units')

  const doc = createDoc('p1')
  check(pageIsEmpty(doc, 'p1'), 'a new page is empty')
  check(trailingPageOp(doc) === null, 'while a page is empty no new one is needed')

  const el = mkStroke('a', [10, 10, 0.5, 40, 40, 0.5])
  doc.elements.a = el
  doc.order.push('a')
  check(!pageIsEmpty(doc, 'p1'), 'a page with writing is not empty')

  const op = trailingPageOp(doc)
  check(op?.t === 'addPage' && op.index === 1, 'a page is added below after writing')
  check(op?.t === 'addPage' && op.page.id === 'p2', 'the identifier is derived from the document rather than random')
  check(
    JSON.stringify(trailingPageOp(doc)) === JSON.stringify(op),
    'recomputing yields the same page, so client and server do not duplicate it',
  )
  applyOp(doc, op!)
  check(doc.pages.length === 2, 'there are two pages now')
  check(trailingPageOp(doc) === null, 'the second is empty, so no third is needed yet')

  // Writing on the second brings a third.
  const el2 = { ...mkStroke('b', [10, 10, 0.5, 40, 40, 0.5]), pageId: doc.pages[1].id }
  doc.elements.b = el2
  doc.order.push('b')
  const op2 = trailingPageOp(doc)
  check(op2?.t === 'addPage', 'writing on the second page starts a third')
  applyOp(doc, op2!)
  check(doc.pages.length === 3 && pageIsEmpty(doc, 'p3'), 'a blank page sits at the bottom again')

  // If a page was deleted, the name must not clash with an existing one.
  const gap = createDoc('p1')
  gap.pages.push({ id: 'p3', name: '3' })
  gap.elements.g = { ...mkStroke('g', [1, 1, 0.5, 5, 5, 0.5]), pageId: 'p3' }
  gap.order.push('g')
  const gapOp = trailingPageOp(gap)!
  check(!gap.pages.some((p) => p.id === gapOp.page.id), 'the new page identifier does not clash with an existing one')

  const el3 = { ...mkStroke('c', [10, 10, 0.5, 40, 40, 0.5]), pageId: 'p3' }
  doc.elements.c = el3
  doc.order.push('c')
  const op3 = trailingPageOp(doc)!
  check(op3.t === 'addPage' && !('background' in op3.page), 'a page carries no look of its own')
}

/* ---------------- colors and PDF ---------------- */
{
  check(parseColor('#ff8800').r === 255 && parseColor('#ff8800').g === 136, 'parsing a hex color')
  check(parseColor('#f80').b === 0, 'parsing a short hex')
  check(near(parseColor('rgba(0,0,0,0.5)').a, 0.5), 'parsing rgba with alpha')

  const doc = createDoc('p1')
  doc.pages.push({ id: 'p2', name: '2' })
  const els: BoardElement[] = [
    mkStroke('s1', [50, 50, 0.3, 300, 200, 0.9, 600, 120, 0.4], 12),
    { ...mkStroke('s2', [100, 400, 0.5, 800, 400, 0.5], 40), brush: 'highlighter', opacity: 0.38, color: '#fde047' },
    mkShape('r1', { fill: '#7dd3fc' }),
    mkShape('e1', { shape: 'ellipse', x: 500, y: 500, w: 300, h: 200 }),
    mkShape('a1', { shape: 'arrow', x: 900, y: 200, w: 300, h: 150 }),
    mkShape('st1', { shape: 'star', x: 1300, y: 300, w: 200, h: 200, rotation: 0.4, fill: '#f9a8d4' }),
    { ...mkShape('r2'), pageId: 'p2', x: 200, y: 200 },
  ]
  for (const el of els) {
    doc.elements[el.id] = el
    doc.order.push(el.id)
  }

  // Regression: stroke outlines are closed, and polyline simplification must not
  // collapse them into a point, or highlighter and pen vanish from the PDF.
  const onlyHl = createDoc('p1')
  const hlEl = {
    ...mkStroke('hl', [160, 300, 0.5, 700, 300, 0.5], 46),
    brush: 'highlighter' as const,
    color: '#fde047',
    opacity: 0.35,
  }
  onlyHl.elements.hl = hlEl
  onlyHl.order.push('hl')
  const hlPdf = buildPdf(onlyHl, { theme: 'light' })!
  const hlText = Buffer.from(
    new Uint8Array(hlPdf.output('arraybuffer') as ArrayBuffer),
  ).toString('latin1')
  const hlStream = inflateStreams(hlText)
  const lineOps = (hlStream.match(/ l\n/g) ?? []).length
  check(lineOps >= 4, `the highlighter stroke is written as a real outline (${lineOps} segments)`)
  check(/0\.99 0\.88 0\.28 rg/.test(hlStream), 'the highlighter color survives into the PDF')

  const pdf = buildPdf(doc, { theme: 'light' })!
  const bytes = new Uint8Array(pdf.output('arraybuffer') as ArrayBuffer)
  const head = String.fromCharCode(...bytes.slice(0, 5))
  check(head === '%PDF-', 'the output is a real PDF')
  check(bytes.length > 3000, `the PDF is not empty (${bytes.length} bytes)`)
  const text = Buffer.from(bytes).toString('latin1')
  check((text.match(/\/Type\s*\/Page[^s]/g) ?? []).length === 2, 'the PDF has two pages')
  check(text.includes('/ExtGState') || text.includes('/GS'), 'transparency is written as an ExtGState')

  const one = buildPdf(doc, { theme: 'light', pageIds: ['p2'] })!
  const t2 = Buffer.from(new Uint8Array(one.output('arraybuffer') as ArrayBuffer)).toString('latin1')
  check((t2.match(/\/Type\s*\/Page[^s]/g) ?? []).length === 1, 'exporting one page yields one page')

  check(buildPdf(doc, { pageIds: ['no-such-page'] }) === null, 'exporting a missing page creates nothing')

  // A viewer must read the page size as A4.
  const media = text.match(/MediaBox\s*\[([^\]]+)\]/)
  const box = media ? media[1].trim().split(/\s+/).map(Number) : []
  check(near(box[2], 595.28, 1.5) && near(box[3], 841.89, 1.5), `the PDF page is A4 (${box[2]}×${box[3]} pt)`)

  // Empty pages stay out of the file: a spare sheet always sits at the bottom.
  const withBlank = createDoc('q1')
  withBlank.pages.push({ id: 'q2', name: '2' })
  withBlank.pages.push({ id: 'q3', name: '3' })
  const only = { ...mkStroke('k', [50, 50, 0.5, 300, 300, 0.9]), pageId: 'q2' }
  withBlank.elements.k = only
  withBlank.order.push('k')
  const trimmed = buildPdf(withBlank, { theme: 'light' })!
  const tt = Buffer.from(new Uint8Array(trimmed.output('arraybuffer') as ArrayBuffer)).toString('latin1')
  check((tt.match(/\/Type\s*\/Page[^s]/g) ?? []).length === 1, 'only the page with content made it into the file')

  const explicit = buildPdf(withBlank, { theme: 'light', pageIds: ['q3'] })!
  const et = Buffer.from(new Uint8Array(explicit.output('arraybuffer') as ArrayBuffer)).toString('latin1')
  check((et.match(/\/Type\s*\/Page[^s]/g) ?? []).length === 1, 'an explicitly chosen empty page is still exported')

  const allBlank = createDoc('z1')
  const blankPdf = buildPdf(allBlank, { theme: 'light' })
  check(blankPdf !== null, 'on a completely empty board export yields one page, not an empty file')
}

/* ---------------- paper: tint, ruling, margins ---------------- */
{
  const paper = { ...DEFAULT_PAPER, ruling: 'grid' as const, rulingMm: 5, marginMm: 10 }
  const area = rulingArea(paper)
  check(near(area.x, 10 * MM) && near(area.y, 10 * MM), 'the ruled area starts at the margin')
  check(
    near(area.w, BOARD_W - 20 * MM) && near(area.h, BOARD_H - 20 * MM),
    'the ruled area is inset on every side',
  )
  check(rulingArea({ ...paper, marginMm: 0 }).x === 0, 'a zero margin rules the whole sheet')
  check(
    rulingArea({ ...paper, marginMm: 999 }).w > 0,
    'an absurd margin is clamped instead of collapsing the sheet',
  )

  const sheet = (over: Partial<typeof paper>) => {
    const doc = createDoc('p1')
    const pdf = buildPdf(doc, { theme: 'light', paper: { ...paper, ...over } })!
    return inflateStreams(
      Buffer.from(new Uint8Array(pdf.output('arraybuffer') as ArrayBuffer)).toString('latin1'),
    )
  }

  const grid = sheet({})
  const lines = grid.split('\n').filter((l) => / l$/.test(l))
  check(lines.length > 40, `the grid reached the PDF (${lines.length} segments)`)
  const xs = lines.map((l) => Number(l.split(' ')[0])).filter((n) => Number.isFinite(n))
  check(
    Math.min(...xs) >= 10 * MM - 0.5,
    `no ruling runs into the margin (leftmost ${Math.min(...xs).toFixed(1)})`,
  )
  check(
    (grid.match(/ re\n/g) ?? []).length >= 2,
    'the sheet and the outline of the ruled area are both rectangles',
  )

  check(sheet({ ruling: 'blank' }).split('\n').filter((l) => / l$/.test(l)).length === 0,
    'plain paper carries no ruling')
  check(
    sheet({ rulingMm: 15 }).split('\n').filter((l) => / l$/.test(l)).length < lines.length,
    'a wider pitch means fewer lines',
  )
  check(
    (sheet({ ruling: 'dots' }).match(/ c\n/g) ?? []).length > 0,
    'dots are drawn as curves',
  )

  // The tint must reach the file: paper is never left pure white.
  const cream = parseColor(PAPER_LOOKS.light.cream.paper)
  const creamFill = `${(cream.r / 255).toFixed(2)} ${(cream.g / 255).toFixed(2)} ${(cream.b / 255).toFixed(2)} rg`
  check(sheet({ tint: 'cream' }).includes(creamFill), `the cream tint reached the PDF (${creamFill})`)
  const blue = parseColor(PAPER_LOOKS.light.blue.paper)
  check(
    sheet({ tint: 'blue' }).includes(
      `${(blue.r / 255).toFixed(2)} ${(blue.g / 255).toFixed(2)} ${(blue.b / 255).toFixed(2)} rg`,
    ),
    'the blue tint reached the PDF',
  )
  check(
    PAPER_LOOKS.light.cream.paper !== '#ffffff' && PAPER_LOOKS.light.plain.paper !== '#ffffff',
    'no tint is pure white',
  )
}

/* ---------------- ribbon of pages ---------------- */
{
  check(PAGE_STRIDE > BOARD_H, 'there is a gap between sheets')
  check(pageTop(0) === 0 && pageTop(2) === 2 * PAGE_STRIDE, 'a sheet offset is a multiple of the stride')
  check(ribbonHeight(1) === BOARD_H, 'a one-sheet ribbon is exactly that sheet tall')
  check(ribbonHeight(3) === 3 * PAGE_STRIDE - (PAGE_STRIDE - BOARD_H), 'the trailing gap is not counted in the height')

  check(pageIndexAt(3, 10) === 0, 'a point on the first sheet')
  check(pageIndexAt(3, BOARD_H - 1) === 0, 'the bottom of the first sheet is still the first')
  check(pageIndexAt(3, PAGE_STRIDE + 5) === 1, 'a point on the second sheet')
  check(pageIndexAt(3, BOARD_H + 5) === 0, 'a point in the gap belongs to the sheet above')
  check(pageIndexAt(3, -500) === 0, 'above the ribbon means the first sheet')
  check(pageIndexAt(3, 99 * PAGE_STRIDE) === 2, 'below the ribbon means the last sheet')
  check(pageIndexAt(0, 100) === 0, 'an empty document does not break the maths')

  // The sheet filling the viewport counts as the current one.
  const view = 800
  check(visiblePageIndex(3, 0, view) === 0, 'at the top the first sheet is in view')
  check(visiblePageIndex(3, PAGE_STRIDE, view) === 1, 'scrolling one sheet makes the second current')
  check(
    visiblePageIndex(3, PAGE_STRIDE - view * 0.3, view) === 1,
    'a sheet becomes current before it covers the whole screen',
  )
}

/* ---------------- partial eraser ---------------- */
{
  const line = (n: number) => {
    const pts: number[] = []
    for (let i = 0; i < n; i++) pts.push(i * 10, 100, 0.5)
    return pts
  }
  const el = mkStroke('e1', line(21), 4) // points from x=0 to x=200

  check(erasePartOfStroke(el, 0, 500, 200, 500, 8) === null, 'an eraser that misses changes nothing')

  // Drag the eraser across the middle.
  const cut = erasePartOfStroke(el, 100, 60, 100, 140, 12)!
  check(cut.length === 2, `the stroke was cut in two (${cut.length})`)
  const xs = (run: number[]) => run.filter((_, i) => i % 3 === 0)
  check(Math.max(...xs(cut[0])) < 100, 'the first piece stayed left of the eraser')
  check(Math.min(...xs(cut[1])) > 100, 'the second piece stayed on the right')
  check(cut[0].length + cut[1].length < el.points.length, 'the erased points are gone')

  // Along the edge, one piece remains.
  const edge = erasePartOfStroke(el, 0, 60, 0, 140, 25)!
  check(edge.length === 1, 'erasing from the edge leaves one piece')
  check(Math.min(...xs(edge[0])) > 10, 'the start of the stroke was erased')

  // A wide eraser across everything leaves nothing.
  const all = erasePartOfStroke(el, -50, 100, 250, 100, 30)!
  check(all.length === 0, 'an eraser along the whole length removes the stroke')

  // Single-point leftovers are dropped, or crumbs stay along the edge.
  const tiny = mkStroke('e2', [0, 0, 0.5, 100, 0, 0.5, 200, 0, 0.5], 4)
  const crumbs = erasePartOfStroke(tiny, 100, 0, 100, 0, 10)!
  check(crumbs.length === 0, 'no single points remain after a cut')

  // Pressure carries into the pieces unchanged.
  const pts: number[] = []
  for (let i = 0; i <= 15; i++) pts.push(i * 10, 0, 0.05 * (i + 1))
  const pressured = mkStroke('e3', pts, 4)
  const kept = erasePartOfStroke(pressured, 75, 0, 75, 0, 12)!
  check(kept.length === 2, `a pressure-varying stroke was cut in two (${kept.length})`)
  check(near(kept[0][2], 0.05) && near(kept[1][2], 0.5), 'pressure in the pieces is unchanged')
  check(kept[0].length / 3 === 7 && kept[1].length / 3 === 7, 'exactly two points vanished under the eraser')
}

/* ---------------- images ---------------- */
{
  const img: BoardElement = {
    id: 'img1',
    type: 'image',
    pageId: PAGE,
    authorId: 'u1',
    createdAt: 1,
    x: 100,
    y: 100,
    w: 200,
    h: 150,
    rotation: 0,
    opacity: 1,
    src: 'data:image/png;base64,iVBORw0KGgo=',
    naturalW: 800,
    naturalH: 600,
    name: 'photo.png',
  }
  check(hitTest(img, 200, 175, 2), 'a click inside an image hits it')
  check(!hitTest(img, 400, 175, 2), 'a click outside an image misses')
  const b = worldBounds(img)
  check(b.w === 200 && b.h === 150, 'image bounds are its rectangle')

  const moved = moveElements([img], 30, -10).get('img1') as { x: number; y: number }
  check(moved.x === 130 && moved.y === 90, 'an image moves')

  const scaled = resizeElements([img], { x: 100, y: 100, w: 200, h: 150 }, 'se', 200, 150, true)
    .patches.get('img1') as Record<string, unknown>
  check(scaled.w === 400 && scaled.h === 300, 'an image scales keeping its aspect ratio')
  check(!('size' in scaled), 'an image has no line thickness')

  const rotated = rotateElements([img], 200, 175, Math.PI / 2).get('img1') as { rotation: number }
  check(near(rotated.rotation, Math.PI / 2), 'an image rotates')

  // Size on the page: a large source is fitted, a small one is not enlarged.
  const big = fitOnPage(4000, 3000)
  check(big.w <= BOARD_W * 0.63 && near(big.w / big.h, 4 / 3), 'a large image fits on the sheet')
  const small = fitOnPage(80, 60)
  check(small.w === 80 && small.h === 60, 'a small image is not stretched')
}

/* ---------------- trackpad pressure (Force Touch) ---------------- */
{
  check(FORCE_TOUCH_SUPPORTED === false, 'outside Safari no Force Touch support is claimed')

  // WebKit landmarks: 1 is an ordinary click, 2 is a force click.
  check(near(forceToPressure(FORCE_MIN), 0.05), 'a light touch gives minimal pressure')
  check(forceToPressure(1) > 0.15 && forceToPressure(1) < 0.35, `an ordinary click gives a thin line (${forceToPressure(1).toFixed(2)})`)
  check(forceToPressure(2) > 0.6 && forceToPressure(2) < 0.85, `a force click is clearly thicker (${forceToPressure(2).toFixed(2)})`)
  check(forceToPressure(FORCE_MAX) === 1, 'the trackpad ceiling gives full thickness')
  check(forceToPressure(99) === 1 && forceToPressure(-5) === 0.05, 'out-of-range values are clamped')
  check(forceToPressure(NaN) === 0.5, 'a garbage value does not break the stroke')
  check(forceToPressure(2) > forceToPressure(1.5) && forceToPressure(1.5) > forceToPressure(1), 'the curve is monotonic')

  // Subscribing to WebKit events without Safari: use a stand-in target.
  class FakeTarget {
    listeners = new Map<string, Set<(e: unknown) => void>>()
    addEventListener(type: string, fn: (e: unknown) => void) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set())
      this.listeners.get(type)!.add(fn)
    }
    removeEventListener(type: string, fn: (e: unknown) => void) {
      this.listeners.get(type)?.delete(fn)
    }
    emit(type: string, event: unknown) {
      for (const fn of this.listeners.get(type) ?? []) fn(event)
    }
    count() {
      return [...this.listeners.values()].reduce((n, s) => n + s.size, 0)
    }
  }

  const target = new FakeTarget()
  const got: number[] = []
  const stop = trackForceTouch(
    target as unknown as HTMLElement,
    (p) => got.push(p),
    true,
  )
  check(target.count() === 4, 'all four WebKit events are subscribed to')

  target.emit('webkitmouseforcechanged', { webkitForce: 1 })
  target.emit('webkitmouseforcechanged', { webkitForce: 2.2 })
  target.emit('webkitmouseforcedown', { webkitForce: 2.6 })
  check(got.length === 3, 'every force change reaches the canvas')
  check(got[1] > got[0] && got[2] > got[1], 'pressure grows together with force')

  let prevented = false
  target.emit('webkitmouseforcewillbegin', { preventDefault: () => { prevented = true } })
  check(prevented, 'the system force click is suppressed so it does not disturb a stroke')

  stop()
  check(target.count() === 0, 'unsubscribing removes every handler')

  const noop = trackForceTouch(target as unknown as HTMLElement, () => {}, false)
  check(target.count() === 0, 'with no browser support nothing is subscribed')
  noop()
}

console.log(failures ? `\n${failures} checks failed` : '\nAll checks passed')
process.exit(failures ? 1 : 0)
