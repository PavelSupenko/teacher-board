import { randomUUID } from 'node:crypto'
import { applyOp, createDoc, DEFAULT_PAPER, opTargets, trailingPageOp } from '../shared/doc.js'

const PEER_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6',
  '#0ea5e9', '#6366f1', '#a855f7', '#ec4899', '#78716c',
]

const DEFAULT_SETTINGS = {
  defaultRole: 'editor',
  followMode: false,
  hostPageId: null,
  locked: false,
  roomName: '',
  theme: 'light',
  paper: DEFAULT_PAPER,
}

/** Ceiling for a single element: the client already shrinks images, but check. */
const MAX_ELEMENT_BYTES = 4 * 1024 * 1024

/** Operations only the host may perform. */
const HOST_ONLY_OPS = new Set(['removePage', 'clearPage', 'movePage'])

/**
 * Appending a blank page at the end is harmless and everyone who writes needs
 * it: offline a client keeps the "one blank sheet at the bottom" invariant on
 * its own, and on reconnecting its pages must land in the same places or what
 * was drawn on them would hang in nowhere. Inserting a page in the middle stays
 * with the host.
 */
const isTrailingPageAppend = (doc, op) =>
  op.t === 'addPage' && op.index === doc.pages.length

export class Room {
  constructor({ hostKey, onPersist }) {
    this.hostKey = hostKey
    this.onPersist = onPersist
    this.doc = createDoc()
    this.settings = { ...DEFAULT_SETTINGS, hostPageId: this.doc.pages[0].id }
    /** @type {Map<string, {id:string,ws:any,name:string,role:string,color:string,activePageId:string|null}>} */
    this.clients = new Map()
    /** Roles of departed clients, so a page reload does not reset rights. */
    this.formerRoles = new Map()
    this.rev = 0
    this.colorCursor = 0
    this.ensureTrailingPage()
  }

  /**
   * Adds a blank page at the bottom when the last one is taken.
   * The server does this rather than the client: a pupil who writes to the end
   * needs a new page too, and has no right to add one.
   */
  ensureTrailingPage() {
    const op = trailingPageOp(this.doc)
    if (!op) return null
    applyOp(this.doc, op)
    this.rev++
    this.broadcast({ t: 'op', op, from: 'server', rev: this.rev })
    return op
  }

  /* ---------------- persistence ---------------- */

  snapshot() {
    return { doc: this.doc, settings: this.settings, rev: this.rev }
  }

  restore(snapshot) {
    if (!snapshot?.doc?.pages?.length) return false
    this.doc = snapshot.doc
    this.settings = { ...DEFAULT_SETTINGS, ...(snapshot.settings ?? {}) }
    if (!this.doc.pages.some((p) => p.id === this.settings.hostPageId)) {
      this.settings.hostPageId = this.doc.pages[0].id
    }
    this.rev = snapshot.rev ?? 0
    this.ensureTrailingPage()
    return true
  }

  /* ---------------- participants ---------------- */

  join(ws, { name, key, clientId }) {
    const isHost = Boolean(this.hostKey) && key === this.hostKey

    // The same participant reconnected, most likely by reloading the tab; close
    // the old socket at once or they would linger in the list until it times out.
    const stale = clientId ? this.clients.get(clientId) : null
    if (stale) {
      this.clients.delete(clientId)
      this.formerRoles.set(clientId, stale.role)
      try {
        stale.ws.close(4000, 'Reconnecting')
      } catch {
        /* the socket is already dead */
      }
    }

    // Reconnecting with the same id keeps the role, for instance after F5.
    // The host role is never restored from an id, only from the key: otherwise
    // someone else's clientId would hand out full rights.
    const previous = clientId ? this.formerRoles.get(clientId) : null
    const id = clientId || randomUUID()
    const inherited = previous && previous !== 'host' ? previous : null
    const role = isHost ? 'host' : (inherited ?? this.settings.defaultRole)
    const client = {
      id,
      ws,
      name: (name || 'Guest').slice(0, 40),
      role,
      color: PEER_COLORS[this.colorCursor++ % PEER_COLORS.length],
      activePageId: this.settings.hostPageId,
    }
    this.clients.set(id, client)
    this.sendTo(client, {
      t: 'welcome',
      selfId: id,
      role: client.role,
      doc: this.doc,
      peers: this.peerList(),
      settings: this.settings,
      rev: this.rev,
    })
    this.broadcastPeers()
    return client
  }

  leave(client) {
    // If someone already reconnected under this id, the map holds the new
    // client; closing the old socket must not evict them.
    if (this.clients.get(client.id) !== client) return
    this.clients.delete(client.id)
    this.formerRoles.set(client.id, client.role)
    this.broadcast({ t: 'live', from: client.id, id: '', pageId: '', points: [], end: true })
    this.broadcastPeers()
  }

  peerList() {
    return [...this.clients.values()].map((c) => ({
      id: c.id,
      name: c.name,
      role: c.role,
      color: c.color,
      activePageId: c.activePageId,
    }))
  }

  hasHost() {
    return [...this.clients.values()].some((c) => c.role === 'host')
  }

  /* ---------------- broadcasting ---------------- */

  sendTo(client, msg) {
    if (client.ws.readyState === 1) client.ws.send(JSON.stringify(msg))
  }

  broadcast(msg, exclude = null) {
    const data = JSON.stringify(msg)
    for (const c of this.clients.values()) {
      if (c.id === exclude) continue
      if (c.ws.readyState === 1) c.ws.send(data)
    }
  }

  broadcastPeers() {
    this.broadcast({ t: 'peers', peers: this.peerList() })
  }

  broadcastSettings() {
    this.broadcast({ t: 'settings', settings: this.settings })
  }

  /* ---------------- permissions ---------------- */

  /**
   * Refusal code, or null when the operation is allowed. Only a code travels:
   * the wording lives on the client, which knows the participant's language.
   *
   * @returns {string|null}
   */
  denyReason(client, op) {
    if (client.role === 'host') return null
    if (client.role === 'viewer') return 'viewer'
    if (this.settings.locked) return 'locked'
    if (HOST_ONLY_OPS.has(op.t)) return 'hostOnly'
    if (op.t === 'addPage' && !isTrailingPageAppend(this.doc, op)) {
      return 'pageMiddle'
    }
    if (op.t === 'add' && op.el?.authorId !== client.id) return 'foreignAuthor'
    if (op.t === 'add' && JSON.stringify(op.el).length > MAX_ELEMENT_BYTES) {
      return 'tooLarge'
    }
    for (const el of opTargets(this.doc, op)) {
      if (el.authorId !== client.id) return 'foreignObject'
    }
    return null
  }

  /* ---------------- messages ---------------- */

  handle(client, msg) {
    switch (msg.t) {
      case 'op': {
        const op = msg.op
        if (!op || typeof op.t !== 'string') return
        const deny = this.denyReason(client, op)
        if (deny) {
          this.sendTo(client, { t: 'denied', op, reason: deny })
          return
        }
        if (!applyOp(this.doc, op)) return
        this.rev++
        this.broadcast({ t: 'op', op, from: client.id, rev: this.rev })
        this.ensureTrailingPage()
        this.onPersist?.()
        return
      }
      case 'live': {
        if (client.role === 'viewer' || (this.settings.locked && client.role !== 'host')) return
        this.broadcast(
          {
            t: 'live',
            from: client.id,
            id: msg.id,
            pageId: msg.pageId,
            style: msg.style,
            points: msg.points ?? [],
            end: Boolean(msg.end),
          },
          client.id,
        )
        return
      }
      case 'cursor': {
        this.broadcast(
          {
            t: 'cursor',
            from: client.id,
            pageId: msg.pageId,
            x: msg.x,
            y: msg.y,
            drawing: Boolean(msg.drawing),
          },
          client.id,
        )
        return
      }
      case 'activePage': {
        client.activePageId = msg.pageId
        if (client.role === 'host') {
          this.settings.hostPageId = msg.pageId
          this.broadcastSettings()
        }
        this.broadcastPeers()
        return
      }
      case 'rename': {
        client.name = String(msg.name || 'Guest').slice(0, 40)
        this.broadcastPeers()
        return
      }
      case 'setRole': {
        if (client.role !== 'host') return
        const target = this.clients.get(msg.clientId)
        if (!target || target.id === client.id) return
        if (!['host', 'editor', 'viewer'].includes(msg.role)) return
        target.role = msg.role
        this.sendTo(target, { t: 'role', role: msg.role })
        this.broadcastPeers()
        return
      }
      case 'kick': {
        if (client.role !== 'host') return
        const target = this.clients.get(msg.clientId)
        if (!target || target.id === client.id) return
        this.sendTo(target, { t: 'kicked', reason: 'host' })
        setTimeout(() => target.ws.close(), 50)
        return
      }
      case 'settings': {
        if (client.role !== 'host') return
        const patch = msg.patch ?? {}
        const allowed = [
          'defaultRole',
          'followMode',
          'hostPageId',
          'locked',
          'roomName',
          'theme',
          'paper',
        ]
        for (const k of allowed) {
          if (k in patch) this.settings[k] = patch[k]
        }
        this.broadcastSettings()
        this.onPersist?.()
        return
      }
      case 'resync':
        this.sendTo(client, { t: 'sync', doc: this.doc, rev: this.rev })
        return
      case 'ping':
        this.sendTo(client, { t: 'pong' })
    }
  }
}
