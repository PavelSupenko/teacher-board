import { applyOp, createDoc } from '../../shared/doc.js'
import type { BoardDoc, BoardElement, Op, Page } from './types'

type Listener = () => void

/** One history entry: how to undo an operation and how to redo it. */
interface HistoryEntry {
  undo: Op[]
  redo: Op[]
}

/**
 * Store holding the board document.
 *
 * Every change goes through `commit`, which applies the operation locally,
 * records its inverse in the history and hands it out for broadcasting.
 * Operations from other participants arrive via `applyRemote` and never touch
 * the local history.
 */
export class BoardStore {
  doc: BoardDoc = createDoc()
  version = 0

  private listeners = new Set<Listener>()
  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []
  private batch: HistoryEntry | null = null

  onOp: ((op: Op) => void) | null = null

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getSnapshot = (): number => this.version

  private emit() {
    this.version++
    for (const fn of this.listeners) fn()
  }

  replace(doc: BoardDoc) {
    this.doc = doc
    this.undoStack = []
    this.redoStack = []
    this.emit()
  }

  /* ---------------- history ---------------- */

  /** Groups several operations into a single undo step. */
  transaction<T>(fn: () => T): T {
    if (this.batch) return fn()
    this.batch = { undo: [], redo: [] }
    try {
      return fn()
    } finally {
      const entry = this.batch
      this.batch = null
      if (entry.redo.length) {
        this.undoStack.push(entry)
        this.redoStack = []
        if (this.undoStack.length > 200) this.undoStack.shift()
      }
    }
  }

  private push(entry: HistoryEntry) {
    if (this.batch) {
      this.batch.undo.unshift(...entry.undo)
      this.batch.redo.push(...entry.redo)
      return
    }
    this.undoStack.push(entry)
    this.redoStack = []
    if (this.undoStack.length > 200) this.undoStack.shift()
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  undo() {
    const entry = this.undoStack.pop()
    if (!entry) return
    for (const op of entry.undo) this.dispatch(op)
    this.redoStack.push(entry)
    this.emit()
  }

  redo() {
    const entry = this.redoStack.pop()
    if (!entry) return
    for (const op of entry.redo) this.dispatch(op)
    this.undoStack.push(entry)
    this.emit()
  }

  private dispatch(op: Op) {
    applyOp(this.doc, op)
    this.onOp?.(op)
  }

  /* ---------------- operations ---------------- */

  /** Applies an operation, sends it over the network and records the history. */
  commit(op: Op, { history = true }: { history?: boolean } = {}) {
    const inverse = history ? this.invert(op) : null
    if (!applyOp(this.doc, op)) return
    this.onOp?.(op)
    if (inverse) this.push({ undo: inverse, redo: [op] })
    this.emit()
  }

  /**
   * Applies an operation without recording history — for continuous gestures
   * (dragging, resizing) where the undo step is assembled by hand.
   * `send = false` keeps the network quiet between frames.
   */
  applyLocal(op: Op, send = true) {
    if (!applyOp(this.doc, op)) return
    if (send) this.onOp?.(op)
    this.emit()
  }

  /** Adds a history step by hand, once a gesture is finished. */
  pushHistory(undo: Op[], redo: Op[]) {
    if (!undo.length || !redo.length) return
    this.push({ undo, redo })
  }

  applyRemote(op: Op) {
    if (applyOp(this.doc, op)) this.emit()
  }

  /** Inverse operations used for undo. */
  private invert(op: Op): Op[] | null {
    const doc = this.doc
    switch (op.t) {
      case 'add':
        return [{ t: 'remove', ids: [op.el.id] }]
      case 'update': {
        const el = doc.elements[op.id]
        if (!el) return null
        const patch: Record<string, unknown> = {}
        for (const k of Object.keys(op.patch)) {
          patch[k] = (el as unknown as Record<string, unknown>)[k]
        }
        return [{ t: 'update', id: op.id, patch }]
      }
      case 'remove': {
        const ops: Op[] = []
        for (const id of op.ids) {
          const el = doc.elements[id]
          if (el) ops.push({ t: 'add', el: structuredClone(el), index: doc.order.indexOf(id) })
        }
        return ops.length ? ops : null
      }
      case 'clearPage': {
        const ops: Op[] = []
        doc.order.forEach((id, index) => {
          const el = doc.elements[id]
          if (el && el.pageId === op.pageId) {
            ops.push({ t: 'add', el: structuredClone(el), index })
          }
        })
        return ops.length ? ops : [{ t: 'clearPage', pageId: op.pageId }]
      }
      case 'addPage':
        return [{ t: 'removePage', pageId: op.page.id }]
      case 'removePage': {
        const idx = doc.pages.findIndex((p) => p.id === op.pageId)
        if (idx === -1) return null
        const ops: Op[] = [
          { t: 'addPage', page: structuredClone(doc.pages[idx]), index: idx },
        ]
        doc.order.forEach((id, index) => {
          const el = doc.elements[id]
          if (el && el.pageId === op.pageId) {
            ops.push({ t: 'add', el: structuredClone(el), index })
          }
        })
        return ops
      }
      case 'patchPage': {
        const page = doc.pages.find((p) => p.id === op.pageId)
        if (!page) return null
        const patch: Partial<Page> = {}
        for (const k of Object.keys(op.patch) as (keyof Page)[]) {
          ;(patch as Record<string, unknown>)[k] = page[k]
        }
        return [{ t: 'patchPage', pageId: op.pageId, patch }]
      }
      case 'movePage': {
        const idx = doc.pages.findIndex((p) => p.id === op.pageId)
        return idx === -1 ? null : [{ t: 'movePage', pageId: op.pageId, index: idx }]
      }
      case 'z':
      case 'setOrder':
        return [{ t: 'setOrder', ids: [...doc.order] }]
      default:
        return null
    }
  }

  /* ---------------- reading ---------------- */

  element(id: string): BoardElement | undefined {
    return this.doc.elements[id]
  }

  elementsOf(pageId: string): BoardElement[] {
    const out: BoardElement[] = []
    for (const id of this.doc.order) {
      const el = this.doc.elements[id]
      if (el && el.pageId === pageId) out.push(el)
    }
    return out
  }
}
