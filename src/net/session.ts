import { BoardStore } from '../model/store'
import { trailingPageOp } from '../../shared/doc.js'
import { t, type MessageKey } from '../i18n'
import { DEFAULT_PAPER } from '../model/types'
import type {
  ClientMessage,
  LiveStroke,
  Op,
  Peer,
  Role,
  RoomSettings,
  ServerMessage,
} from '../model/types'

export type ConnStatus = 'connecting' | 'online' | 'offline' | 'kicked'

/** The server sends refusal codes; the wording lives on the client. */
function denialMessage(code: string): string {
  const key = `deny.${code}` as MessageKey
  const text = t(key)
  return text === key ? code : text
}

const DEFAULT_SETTINGS: RoomSettings = {
  defaultRole: 'editor',
  followMode: false,
  hostPageId: null,
  locked: false,
  roomName: '',
  theme: 'light',
  paper: DEFAULT_PAPER,
}

export interface PeerCursor {
  id: string
  pageId: string
  x: number
  y: number
  drawing: boolean
  at: number
}

/**
 * Network session: keeps a WebSocket to the local server and syncs the
 * document along with live data — unfinished strokes and cursors.
 *
 * If the server is unreachable the session keeps working on its own: the board
 * stays fully usable, just without other participants.
 */
export class Session {
  store = new BoardStore()
  status: ConnStatus = 'connecting'
  statusMessage = ''
  selfId = 'local'
  role: Role = 'host'
  peers: Peer[] = []
  settings: RoomSettings = { ...DEFAULT_SETTINGS }
  /** Unfinished strokes of other participants: author id to stroke. */
  remoteLive = new Map<string, LiveStroke>()
  cursors = new Map<string, PeerCursor>()

  private ws: WebSocket | null = null
  private listeners = new Set<() => void>()
  private version = 0
  private retry = 0
  private retryTimer: number | null = null
  private lastCursorAt = 0
  private closedByUs = false
  private queue: ClientMessage[] = []
  /** Operations made while offline; replayed once the connection returns. */
  private outbox: Op[] = []

  constructor(
    private name: string,
    private key: string | null,
  ) {
    this.store.onOp = (op) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.sendNow({ t: 'op', op })
      } else {
        // Nothing is lost offline: queue it and send once we are back.
        this.outbox.push(op)
        if (this.outbox.length > 20000) this.outbox.shift()
        this.emit()
      }
      // The server keeps the "one blank sheet at the bottom" invariant; with no
      // server we keep it ourselves, or an offline board runs out of paper.
      if (this.status === 'offline') queueMicrotask(() => this.ensureTrailingPage())
    }
  }

  /** How many actions have not reached the server yet. */
  get pendingCount(): number {
    return this.outbox.length
  }

  private ensureTrailingPage() {
    const op = trailingPageOp(this.store.doc)
    // The page is queued like everything else: after reconnecting it lands on
    // the server under the same id, so what was drawn on it survives.
    if (op) this.store.applyLocal(op, true)
  }

  /* ---------------- subscription for React ---------------- */

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getSnapshot = (): number => this.version

  private emit() {
    this.version++
    for (const fn of this.listeners) fn()
  }

  /* ---------------- connection ---------------- */

  connect() {
    if (typeof WebSocket === 'undefined') return this.goOffline('WebSocket unavailable')
    this.closedByUs = false
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    let ws: WebSocket
    try {
      ws = new WebSocket(`${proto}//${location.host}/ws`)
    } catch {
      return this.goOffline('Could not open the connection')
    }
    this.ws = ws
    this.setStatus('connecting')

    ws.onopen = () => {
      this.retry = 0
      const saved = localStorage.getItem('tb:clientId') ?? undefined
      this.sendNow({ t: 'hello', name: this.name, key: this.key ?? undefined, clientId: saved })
      for (const m of this.queue.splice(0)) this.sendNow(m)
    }
    ws.onmessage = (ev) => {
      let msg: ServerMessage
      try {
        msg = JSON.parse(ev.data as string)
      } catch {
        return
      }
      this.handle(msg)
    }
    ws.onclose = () => {
      this.ws = null
      if (this.closedByUs || this.status === 'kicked') return
      this.goOffline('Lost the connection to the server')
      this.scheduleReconnect()
    }
    ws.onerror = () => {
      /* handled by onclose */
    }
  }

  private scheduleReconnect() {
    if (this.retryTimer != null) return
    const delay = Math.min(800 * 2 ** this.retry, 8000)
    this.retry++
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, delay)
  }

  disconnect() {
    this.closedByUs = true
    if (this.retryTimer != null) window.clearTimeout(this.retryTimer)
    this.ws?.close()
    this.ws = null
  }

  private goOffline(message: string) {
    this.status = 'offline'
    this.statusMessage = message
    this.remoteLive.clear()
    this.cursors.clear()
    this.peers = []
    this.emit()
  }

  private setStatus(s: ConnStatus, message = '') {
    this.status = s
    this.statusMessage = message
    this.emit()
  }

  private handle(msg: ServerMessage) {
    switch (msg.t) {
      case 'welcome': {
        this.selfId = msg.selfId
        localStorage.setItem('tb:clientId', msg.selfId)
        this.role = msg.role
        this.peers = msg.peers
        this.settings = msg.settings
        this.store.replace(msg.doc)
        // Replay everything drawn offline on top of the server state and send
        // it right away, so a dropped connection costs no work.
        const pending = this.outbox.splice(0)
        for (const op of pending) this.store.applyLocal(op, true)
        this.setStatus('online')
        return
      }
      case 'op':
        if (msg.from !== this.selfId) this.store.applyRemote(msg.op)
        return
      case 'live': {
        if (msg.from === this.selfId) return
        if (msg.end) {
          this.remoteLive.delete(msg.from)
          return
        }
        const cur = this.remoteLive.get(msg.from)
        if (cur && cur.id === msg.id) {
          cur.points.push(...msg.points)
        } else if (msg.style) {
          this.remoteLive.set(msg.from, {
            id: msg.id,
            pageId: msg.pageId,
            points: [...msg.points],
            ...msg.style,
          })
        }
        return
      }
      case 'cursor':
        if (msg.from === this.selfId) return
        this.cursors.set(msg.from, {
          id: msg.from,
          pageId: msg.pageId,
          x: msg.x,
          y: msg.y,
          drawing: msg.drawing,
          at: performance.now(),
        })
        return
      case 'peers': {
        this.peers = msg.peers
        const alive = new Set(msg.peers.map((p) => p.id))
        for (const id of [...this.cursors.keys()]) if (!alive.has(id)) this.cursors.delete(id)
        for (const id of [...this.remoteLive.keys()]) if (!alive.has(id)) this.remoteLive.delete(id)
        this.emit()
        return
      }
      case 'role':
        this.role = msg.role
        this.emit()
        return
      case 'settings':
        this.settings = msg.settings
        this.emit()
        return
      case 'kicked':
        this.closedByUs = true
        this.setStatus('kicked', t('kicked.reason'))
        this.ws?.close()
        return
      case 'denied':
        // The operation was applied optimistically, so ask the server for a
        // fresh snapshot to keep the local board in step with the shared one.
        this.statusMessage = denialMessage(msg.reason)
        this.send({ t: 'resync' })
        this.emit()
        return
      case 'sync':
        this.store.replace(msg.doc)
        this.emit()
        return
      case 'pong':
    }
  }

  /* ---------------- sending ---------------- */

  private sendNow(msg: ClientMessage) {
    this.ws?.send(JSON.stringify(msg))
  }

  private send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.sendNow(msg)
  }

  sendLive(
    id: string,
    pageId: string,
    points: number[],
    style?: Omit<LiveStroke, 'id' | 'pageId' | 'points'>,
    end = false,
  ) {
    if (!points.length && !end) return
    this.send({ t: 'live', id, pageId, points, style, end })
  }

  sendCursor(pageId: string, x: number, y: number, drawing: boolean) {
    const now = performance.now()
    if (now - this.lastCursorAt < 40) return
    this.lastCursorAt = now
    this.send({ t: 'cursor', pageId, x, y, drawing })
  }

  setActivePage(pageId: string) {
    this.send({ t: 'activePage', pageId })
  }

  setRole(clientId: string, role: Role) {
    this.send({ t: 'setRole', clientId, role })
  }

  kick(clientId: string) {
    this.send({ t: 'kick', clientId })
  }

  patchSettings(patch: Partial<RoomSettings>) {
    // Optimistic: the server confirms with its own settings message anyway.
    this.settings = { ...this.settings, ...patch }
    this.emit()
    this.send({ t: 'settings', patch })
  }

  rename(name: string) {
    this.name = name
    localStorage.setItem('tb:name', name)
    this.send({ t: 'rename', name })
  }

  /* ---------------- rights ---------------- */

  get isHost(): boolean {
    return this.role === 'host'
  }

  /** Whether this participant may change anything on the board at all. */
  get canDraw(): boolean {
    if (this.status === 'offline') return true
    if (this.role === 'host') return true
    if (this.role === 'viewer') return false
    return !this.settings.locked
  }

  /** Whether a particular element may be changed or removed. */
  canEditElement(authorId: string): boolean {
    if (!this.canDraw) return false
    return this.role === 'host' || authorId === this.selfId
  }

  peer(id: string): Peer | undefined {
    return this.peers.find((p) => p.id === id)
  }
}
