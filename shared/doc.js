// The single implementation of applying operations to a document.
// Used by both the client (TypeScript) and the local server (Node).

/** Default look of the paper, shared by the client and the server. */
export const DEFAULT_PAPER = {
  tint: 'cream',
  ruling: 'grid',
  rulingMm: 5,
  marginMm: 10,
  texture: false,
}

export function createPage(id, name) {
  return { id, name }
}

export function createDoc(firstPageId = 'p1') {
  return {
    pages: [createPage(firstPageId, 'Page 1')],
    elements: {},
    order: [],
  }
}

/**
 * Applies an operation to the document, mutating it.
 * Returns true when the document actually changed.
 */
export function applyOp(doc, op) {
  switch (op.t) {
    case 'add': {
      if (!op.el || doc.elements[op.el.id]) return false
      doc.elements[op.el.id] = op.el
      if (typeof op.index === 'number' && op.index >= 0 && op.index <= doc.order.length) {
        doc.order.splice(op.index, 0, op.el.id)
      } else {
        doc.order.push(op.el.id)
      }
      return true
    }
    case 'update': {
      const el = doc.elements[op.id]
      if (!el) return false
      Object.assign(el, op.patch)
      return true
    }
    case 'remove': {
      let changed = false
      const kill = new Set(op.ids)
      for (const id of op.ids) {
        if (doc.elements[id]) {
          delete doc.elements[id]
          changed = true
        }
      }
      if (changed) doc.order = doc.order.filter((id) => !kill.has(id))
      return changed
    }
    case 'clearPage': {
      const keep = []
      let changed = false
      for (const id of doc.order) {
        const el = doc.elements[id]
        if (el && el.pageId === op.pageId) {
          delete doc.elements[id]
          changed = true
        } else {
          keep.push(id)
        }
      }
      doc.order = keep
      return changed
    }
    case 'addPage': {
      if (doc.pages.some((p) => p.id === op.page.id)) return false
      const at = Math.max(0, Math.min(doc.pages.length, op.index ?? doc.pages.length))
      doc.pages.splice(at, 0, op.page)
      return true
    }
    case 'removePage': {
      if (doc.pages.length <= 1) return false
      const idx = doc.pages.findIndex((p) => p.id === op.pageId)
      if (idx === -1) return false
      doc.pages.splice(idx, 1)
      applyOp(doc, { t: 'clearPage', pageId: op.pageId })
      return true
    }
    case 'patchPage': {
      const page = doc.pages.find((p) => p.id === op.pageId)
      if (!page) return false
      Object.assign(page, op.patch)
      return true
    }
    case 'movePage': {
      const idx = doc.pages.findIndex((p) => p.id === op.pageId)
      if (idx === -1) return false
      const to = Math.max(0, Math.min(doc.pages.length - 1, op.index))
      if (to === idx) return false
      const [page] = doc.pages.splice(idx, 1)
      doc.pages.splice(to, 0, page)
      return true
    }
    case 'setOrder': {
      const known = op.ids.filter((id) => doc.elements[id])
      const missing = doc.order.filter((id) => !known.includes(id))
      doc.order = [...known, ...missing]
      return true
    }
    case 'z': {
      const move = new Set(op.ids.filter((id) => doc.elements[id]))
      if (!move.size) return false
      const rest = doc.order.filter((id) => !move.has(id))
      const moved = doc.order.filter((id) => move.has(id))
      doc.order = op.to === 'front' ? [...rest, ...moved] : [...moved, ...rest]
      return true
    }
    default:
      return false
  }
}

/** Elements of a page in drawing order, bottom to top. */
export function pageElements(doc, pageId) {
  const out = []
  for (const id of doc.order) {
    const el = doc.elements[id]
    if (el && el.pageId === pageId) out.push(el)
  }
  return out
}

/** Whether a page holds anything at all. */
export function pageIsEmpty(doc, pageId) {
  for (const id of doc.order) {
    const el = doc.elements[id]
    if (el && el.pageId === pageId) return false
  }
  return true
}

/**
 * One blank sheet must always remain at the bottom: as soon as something lands
 * on the last one, a new page appears below it, so the notebook never runs out
 * mid-lesson.
 *
 * The identifier is derived from the document state rather than from a random
 * generator. That way the server and a client that lost its connection give the
 * same page the same name, and reconnecting does not duplicate it: adding a
 * page with an existing id is simply ignored.
 *
 * Returns the add-page operation, or null when nothing is needed.
 */
export function trailingPageOp(doc) {
  const last = doc.pages[doc.pages.length - 1]
  if (!last || pageIsEmpty(doc, last.id)) return null
  let n = doc.pages.length + 1
  while (doc.pages.some((p) => p.id === `p${n}`)) n++
  return {
    t: 'addPage',
    page: { id: `p${n}`, name: `Page ${n}` },
    index: doc.pages.length,
  }
}

/** Which elements an operation touches; used for permission checks. */
export function opTargets(doc, op) {
  switch (op.t) {
    case 'add':
      return op.el ? [op.el] : []
    case 'update': {
      const el = doc.elements[op.id]
      return el ? [el] : []
    }
    case 'remove':
    case 'z':
      return op.ids.map((id) => doc.elements[id]).filter(Boolean)
    default:
      return []
  }
}
