import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join, normalize, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { Room } from './room.js'
import { BLOCKED_HINT, installHint, looksBlocked, openTunnel, PROVIDERS } from './tunnel.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DIST = join(ROOT, 'dist')
const STATE_DIR = process.env.BOARD_STATE_DIR ?? join(ROOT, '.board-sessions')
const STATE_FILE = join(STATE_DIR, 'room.json')

const PORT = Number(process.env.PORT ?? 4321)

/**
 * The host key stays the same between runs unless BOARD_KEY overrides it, so a
 * teacher can bookmark their link once instead of digging it out of the
 * terminal every lesson. It never leaves this machine.
 */
function hostKey() {
  if (process.env.BOARD_KEY) return process.env.BOARD_KEY
  const file = join(STATE_DIR, 'host-key')
  try {
    const saved = readFileSync(file, 'utf8').trim()
    if (saved) return saved
  } catch {
    /* first run */
  }
  const fresh = randomBytes(4).toString('hex')
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(file, fresh, 'utf8')
  } catch {
    /* a read-only folder just means a new key next time */
  }
  return fresh
}
const HOST_KEY = hostKey()

/** Open the host link in the browser: the launcher is a double-click, not a terminal. */
const OPEN_BROWSER = process.argv.includes('--open') || process.env.BOARD_OPEN === '1'

function openInBrowser(url) {
  const [bin, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  try {
    spawn(bin, args, { detached: true, stdio: 'ignore' }).unref()
  } catch {
    /* no browser to open; the link is printed anyway */
  }
}
/**
 * Public tunnel: makes the board reachable from any network.
 * BOARD_TUNNEL may also name a provider to pin: "cloudflare" or "ssh".
 */
const TUNNEL_CHOICE = PROVIDERS.includes(process.env.BOARD_TUNNEL ?? '')
  ? process.env.BOARD_TUNNEL
  : null
const USE_TUNNEL =
  process.argv.includes('--tunnel') || process.env.BOARD_TUNNEL === '1' || Boolean(TUNNEL_CHOICE)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

/* ------------------------------------------------------------------ */
/* Persistence: the board survives a server restart                     */
/* ------------------------------------------------------------------ */

let persistTimer = null
let persistPending = false

function schedulePersist() {
  persistPending = true
  if (persistTimer) return
  persistTimer = setTimeout(async () => {
    persistTimer = null
    persistPending = false
    try {
      await mkdir(STATE_DIR, { recursive: true })
      await writeFile(STATE_FILE, JSON.stringify(room.snapshot()), 'utf8')
    } catch (err) {
      console.warn('Could not save the board state:', err.message)
    }
  }, 2000)
}

/** Synchronous save, used on shutdown so a lesson is never lost. */
function persistNow() {
  if (!persistPending && !persistTimer) return
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = null
  persistPending = false
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify(room.snapshot()), 'utf8')
  } catch (err) {
    console.warn('Could not save the board state:', err.message)
  }
}

const room = new Room({ hostKey: HOST_KEY, onPersist: schedulePersist })

if (existsSync(STATE_FILE)) {
  try {
    room.restore(JSON.parse(await readFile(STATE_FILE, 'utf8')))
    console.log('Restored the previous board state.')
  } catch {
    console.warn('The state file is damaged; starting from a clean board.')
  }
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost')
  let pathname = decodeURIComponent(url.pathname)
  if (pathname === '/') pathname = '/index.html'

  const filePath = normalize(join(DIST, pathname))
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403).end('Forbidden')
    return
  }

  try {
    const body = await readFile(filePath)
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': pathname === '/index.html' ? 'no-cache' : 'public, max-age=3600',
    })
    res.end(body)
  } catch {
    // SPA fallback
    try {
      const html = await readFile(join(DIST, 'index.html'))
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' })
      res.end(html)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(
        'The client is not built. Run "npm run build", or "npm run dev" while developing.',
      )
    }
  }
}

const server = createServer((req, res) => {
  if (req.url?.startsWith('/api/info')) {
    res.writeHead(200, { 'Content-Type': MIME['.json'] })
    res.end(
      JSON.stringify({
        roomName: room.settings.roomName,
        peers: room.clients.size,
        hasHost: room.hasHost(),
        port: PORT,
        addresses: lanAddresses(),
      }),
    )
    return
  }
  serveStatic(req, res)
})

/* ------------------------------------------------------------------ */
/* WebSocket                                                           */
/* ------------------------------------------------------------------ */

// Images live in the document as data URLs, so both a single operation and a
// whole board snapshot can be large.
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 * 1024 })

wss.on('connection', (ws) => {
  let client = null
  ws.isAlive = true
  ws.on('pong', () => {
    ws.isAlive = true
  })

  ws.on('message', (data) => {
    let msg
    try {
      msg = JSON.parse(data.toString())
    } catch {
      return
    }
    if (!client) {
      if (msg.t !== 'hello') return
      client = room.join(ws, msg)
      console.log(`+ ${client.name} (${client.role}) — ${room.clients.size} online`)
      return
    }
    try {
      room.handle(client, msg)
    } catch (err) {
      console.error('Failed to handle a message:', err)
    }
  })

  ws.on('close', () => {
    if (client) {
      room.leave(client)
      console.log(`- ${client.name} — ${room.clients.size} left`)
    }
  })
})

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate()
      continue
    }
    ws.isAlive = false
    ws.ping()
  }
}, 15000)
wss.on('close', () => clearInterval(heartbeat))

/* ------------------------------------------------------------------ */
/* Start-up                                                            */
/* ------------------------------------------------------------------ */

function lanAddresses() {
  const out = []
  for (const [, list] of Object.entries(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address)
    }
  }
  return out
}

const RULE = '─'.repeat(64)
const links = (origin) => ({
  host: `${origin}/?key=${HOST_KEY}`,
  guest: `${origin}/`,
})

function printLocalBanner() {
  const addrs = lanAddresses()
  console.log(`\n${RULE}`)
  console.log('  Class Board is running')
  console.log(RULE)
  console.log('\n  On the local network\n')
  console.log('  Host (full rights):')
  console.log(`    ${links(`http://localhost:${PORT}`).host}`)
  for (const a of addrs) console.log(`    ${links(`http://${a}:${PORT}`).host}`)
  console.log('\n  Participants (give this link to the class):')
  if (!addrs.length) console.log(`    ${links(`http://localhost:${PORT}`).guest}`)
  for (const a of addrs) console.log(`    ${links(`http://${a}:${PORT}`).guest}`)
  console.log(`\n  Host key: ${HOST_KEY}   (override with BOARD_KEY)`)
  if (!USE_TUNNEL) {
    console.log('\n  Need access from another network? Run "npm run share".')
  }
  console.log(`${RULE}\n`)
}

let tunnel = null

/** Prints what the tunnel program itself said, plus a hint when the cause is known. */
function explainAttempt(attempt) {
  if (attempt.error === 'not-installed') {
    if (attempt.provider === 'cloudflared') console.warn(installHint(PORT))
    else console.warn(`  ${attempt.provider}: ssh was not found on this machine.`)
    return
  }
  console.warn(`  ${attempt.provider}: ${attempt.error}`)
  for (const line of (attempt.log ?? []).slice(-4)) console.warn(`    ${line}`)
  if (looksBlocked(attempt.log ?? [])) console.warn(`\n${BLOCKED_HINT}`)
}

/**
 * Asks a candidate address whether it is really this board. Tunnel services
 * advertise their own hosts in the greeting, and a link that leads elsewhere is
 * worse than no link at all.
 */
async function servesThisBoard(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`${url}/api/info`, { signal: AbortSignal.timeout(6000) })
      if (res.ok && (await res.json())?.port === PORT) return true
    } catch {
      /* the tunnel may not be routable yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  return false
}

async function openPublicTunnel() {
  console.log('  Opening a public tunnel, this takes a few seconds…\n')
  tunnel = await openTunnel(PORT, {
    prefer: TUNNEL_CHOICE,
    knownHosts: join(STATE_DIR, 'known_hosts'),
    verify: servesThisBoard,
    onExit: (_code, _signal, log = []) => {
      console.warn('\n  The tunnel dropped. The board keeps working on the local network.')
      for (const line of log.slice(-4)) console.warn(`    ${line}`)
      if (looksBlocked(log)) console.warn(`\n${BLOCKED_HINT}\n`)
    },
  })

  if (!tunnel.url) {
    console.warn(`\n${RULE}`)
    console.warn('  Could not open a public tunnel.\n')
    for (const attempt of tunnel.attempts ?? [tunnel]) explainAttempt(attempt)
    console.warn('\n  The board is running, but only on the local network for now.')
    console.warn(`${RULE}\n`)
    return
  }

  // Cloudflare is tried first; saying which way worked saves guessing later.
  for (const attempt of tunnel.attempts ?? []) {
    console.warn(`  ${attempt.provider} did not work: ${attempt.error}`)
    if (looksBlocked(attempt.log ?? [])) console.warn('  Its API looks blocked on this network.')
  }
  if ((tunnel.attempts ?? []).length) console.warn('')

  const { host, guest } = links(tunnel.url)
  console.log(RULE)
  console.log(`  Reachable from any network  ·  via ${tunnel.provider}`)
  console.log(RULE)
  console.log('\n  Host (full rights):')
  console.log(`    ${host}`)
  console.log('\n  Participants (give this link to your pupils):')
  console.log(`    ${guest}`)
  console.log('\n  The link lives as long as this command runs and is known only to')
  console.log('  the people you send it to. Do not show the host link on screen:')
  console.log('  it grants full rights (the browser strips the key from the address).')
  console.log(`${RULE}\n`)
}

server.listen(PORT, '0.0.0.0', () => {
  printLocalBanner()
  if (OPEN_BROWSER) openInBrowser(links(`http://localhost:${PORT}`).host)
  if (USE_TUNNEL) void openPublicTunnel()
})

let stopping = false
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (stopping) process.exit(0)
    stopping = true
    console.log('\nStopping the server…')
    persistNow()
    tunnel?.stop()
    for (const ws of wss.clients) ws.close()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 800)
  })
}

process.on('exit', persistNow)
