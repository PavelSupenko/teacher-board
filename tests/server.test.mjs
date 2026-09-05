/**
 * End-to-end check of the local server: syncing, role permissions, live stroke
 * broadcasting and state recovery.
 * Run with: npm run test:server
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PORT = Number(process.env.PORT ?? 4399)
const KEY = 'testkey'
const url = `ws://localhost:${PORT}/ws`
const stateDir = await mkdtemp(join(tmpdir(), 'board-test-'))

let server = null
function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], {
      env: { ...process.env, PORT: String(PORT), BOARD_KEY: KEY, BOARD_STATE_DIR: stateDir },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    child.stdout.on('data', (d) => {
      if (d.toString().includes('Host key')) resolve(child)
    })
    child.on('error', reject)
    setTimeout(() => reject(new Error('the server did not start')), 8000)
  })
}
async function stopServer() {
  if (!server) return
  const done = new Promise((r) => server.on('exit', r))
  server.kill('SIGTERM')
  await done
  server = null
}
server = await startServer()
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (ok, label) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`)
  if (!ok) failures++
}

function client(name, key, clientId) {
  const ws = new WebSocket(url)
  const inbox = []
  const c = { ws, inbox, self: null, role: null, doc: null }
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString())
    inbox.push(m)
    if (m.t === 'welcome') {
      c.self = m.selfId
      c.role = m.role
      c.doc = m.doc
    }
    if (m.t === 'role') c.role = m.role
  })
  c.ready = new Promise((res) => ws.on('open', () => {
    ws.send(JSON.stringify({ t: 'hello', name, key, clientId }))
    const iv = setInterval(() => { if (c.self) { clearInterval(iv); res(c) } }, 10)
  }))
  c.send = (m) => ws.send(JSON.stringify(m))
  c.last = (t) => [...inbox].reverse().find((m) => m.t === t)
  c.all = (t) => inbox.filter((m) => m.t === t)
  return c
}

const stroke = (id, author, pageId) => ({
  id, type: 'stroke', pageId, authorId: author, createdAt: Date.now(),
  brush: 'pen', points: [10, 10, 0.5, 40, 60, 0.7], color: '#111827',
  size: 4, opacity: 1, simulated: false,
})

const host = client('Teacher', KEY)
await host.ready
const pageId = host.doc.pages[0].id
check(host.role === 'host', 'the key grants the host role')

const pupil = client('Pupil')
await pupil.ready
check(pupil.role === 'editor', 'a new participant gets the default role (editor)')
await wait(60)
check(host.last('peers')?.peers.length === 2, 'the participant list was broadcast')

check(host.doc.pages.length === 1, 'a fresh board has one page')

// 1. operations are synced
host.send({ t: 'op', op: { t: 'add', el: stroke('s1', host.self, pageId) } })
await wait(80)
check(pupil.all('op').some((m) => m.op.el?.id === 's1'), "the host's stroke reached the pupil")

// 1a. writing on the last sheet starts a new one below
const pageOps = () => host.all('op').filter((m) => m.op.t === 'addPage')
check(pageOps().length === 1, 'the server added a page below after the first stroke')
const page2 = pageOps()[0].op.page.id
check(pageOps()[0].from === 'server', 'the page came from the server, not from a participant')
check(pupil.all('op').some((m) => m.op.t === 'addPage' && m.op.page.id === page2), 'the new page was broadcast to everyone')

// 1b. a pupil can write to the end as well; they may not add pages, so the
// server creates one for them
pupil.send({ t: 'op', op: { t: 'add', el: stroke('sp', pupil.self, page2) } })
await wait(120)
check(pageOps().length === 2, "a pupil's stroke on the last sheet also starts a new one")
const page3 = pageOps()[1].op.page.id
check(page3 !== page2, 'the pages are distinct')

// 1c. no extra pages appear
pupil.send({ t: 'op', op: { t: 'add', el: stroke('sp2', pupil.self, page2) } })
await wait(120)
check(pageOps().length === 2, 'a second stroke on the same sheet adds nothing')
host.send({ t: 'op', op: { t: 'remove', ids: ['sp', 'sp2'] } })
await wait(120)

// 2. the pupil draws their own
pupil.send({ t: 'op', op: { t: 'add', el: stroke('s2', pupil.self, pageId) } })
await wait(80)
check(host.all('op').some((m) => m.op.el?.id === 's2'), "the pupil's stroke reached the host")

// 3. a pupil cannot touch someone else's object
pupil.send({ t: 'op', op: { t: 'remove', ids: ['s1'] } })
await wait(80)
check(pupil.last('denied')?.reason === 'foreignObject', "a pupil may not delete another's work")

// 4. a pupil cannot forge authorship
pupil.send({ t: 'op', op: { t: 'add', el: stroke('s3', host.self, pageId) } })
await wait(80)
check(pupil.last('denied')?.reason === 'foreignAuthor', 'forged authorship is rejected')

// 5. the host may delete anything
host.send({ t: 'op', op: { t: 'remove', ids: ['s2'] } })
await wait(80)
check(pupil.all('op').some((m) => m.op.t === 'remove' && m.op.ids.includes('s2')), "the host deleted someone else's object")

// 6. freezing the board
host.send({ t: 'settings', patch: { locked: true } })
await wait(80)
check(pupil.last('settings')?.settings.locked === true, 'the freeze setting was broadcast')
pupil.send({ t: 'op', op: { t: 'add', el: stroke('s4', pupil.self, pageId) } })
await wait(80)
check(pupil.last('denied')?.reason === 'locked', 'a pupil cannot write on a frozen board')
host.send({ t: 'settings', patch: { locked: false } })
await wait(50)

// 7. switching a role to view-only
host.send({ t: 'setRole', clientId: pupil.self, role: 'viewer' })
await wait(80)
check(pupil.role === 'viewer', 'the host lowered the rights to view-only')
pupil.send({ t: 'op', op: { t: 'add', el: stroke('s5', pupil.self, pageId) } })
await wait(80)
check(pupil.last('denied')?.reason === 'viewer', 'a viewer cannot draw')

// 8. only the host manages pages
host.send({ t: 'setRole', clientId: pupil.self, role: 'editor' })
await wait(60)
pupil.send({ t: 'op', op: { t: 'addPage', page: { id: 'px', name: 'X' }, index: 1 } })
await wait(80)
check(pupil.last('denied')?.reason === 'pageMiddle', 'only the host inserts a page in the middle')

// Appending a blank page at the bottom is allowed for anyone who writes:
// offline a client keeps that invariant itself and its pages must line up.
const before9 = pupil.all('denied').length
const tailIndex = pupil.doc ? undefined : undefined
const snapshot = await (async () => {
  pupil.send({ t: 'resync' })
  await wait(120)
  return pupil.last('sync').doc
})()
pupil.send({
  t: 'op',
  op: {
    t: 'addPage',
    page: { id: 'tail-by-pupil', name: 'Tail' },
    index: snapshot.pages.length,
  },
})
await wait(120)
check(pupil.all('denied').length === before9, 'a pupil may append a page at the bottom')
check(host.all('op').some((m) => m.op.t === 'addPage' && m.op.page.id === 'tail-by-pupil'), "the pupil's page was broadcast")

// 9. live strokes are broadcast, but not back to their author
pupil.send({ t: 'live', id: 'L1', pageId, style: { brush: 'pen', color: '#000', size: 4, opacity: 1, simulated: false }, points: [1, 2, 0.5] })
await wait(80)
check(host.all('live').some((m) => m.id === 'L1'), 'an unfinished stroke is broadcast')
check(!pupil.all('live').some((m) => m.id === 'L1'), 'the author does not receive their own stroke back')

// 10. board state for a newly joined participant
const late = client('Latecomer')
await late.ready
check(late.doc.elements.s1 && !late.doc.elements.s2, 'a new participant gets the current board snapshot')

// 11. disconnecting a participant
host.send({ t: 'kick', clientId: late.self })
await wait(120)
check(late.last('kicked') !== undefined, 'the host can disconnect a participant')

// 12. a refusal is healed by resyncing
pupil.send({ t: 'op', op: { t: 'remove', ids: ['s1'] } })
await wait(80)
pupil.send({ t: 'resync' })
await wait(120)
check(pupil.last('sync')?.doc?.elements?.s1 !== undefined, 'after a refusal the server sends a fresh snapshot')

// 10a. a pupil who lost the connection sees everything drawn while away
const away = client('Away')
await away.ready
const awayId = away.self
away.ws.close()
await wait(200)
host.send({ t: 'op', op: { t: 'add', el: stroke('while-away', host.self, pageId) } })
await wait(120)
const back = client('Away', undefined, awayId)
await back.ready
check(!!back.doc.elements['while-away'], 'what was drawn while away is visible on return')
check(!!back.doc.elements.s1, 'and everything from before is still there')
back.ws.close()
await wait(150)

// 11a. reloading a tab does not breed ghost participants
const reload = client('Pupil', undefined, pupil.self)
await reload.ready
await wait(200)
const names = reload.last('peers')?.peers ?? []
check(names.filter((p) => p.id === pupil.self).length === 1, 'reconnecting does not duplicate a participant')
check(reload.role === 'editor', 'the role survives reconnecting with the same id')
check(names.length === 2, `exactly two people in the room, no ghosts (${names.map((p) => p.name).join(', ')})`)
reload.ws.close()
await wait(150)

// 11b. someone else's clientId does not grant the host role
const impostor = client('Impostor', undefined, host.self)
await impostor.ready
check(impostor.role !== 'host', "another's clientId does not hand out host rights")
impostor.ws.close()
await wait(150)

for (const c of [host, late]) c.ws.close()
await wait(150)

// 13. state survives a server restart
await stopServer()
await wait(200)
server = await startServer()
const afterRestart = client('After restart', KEY)
await afterRestart.ready
check(!!afterRestart.doc.elements.s1, 'the board was restored after the server restarted')
check(afterRestart.role === 'host', 'the host key still works after a restart')
const pages = afterRestart.doc.pages
const lastPage = pages[pages.length - 1].id
const busy = Object.values(afterRestart.doc.elements).some((el) => el.pageId === lastPage)
check(!busy, 'a blank sheet still sits at the bottom after a restart')
afterRestart.ws.close()
await wait(80)

await stopServer()
await rm(stateDir, { recursive: true, force: true })
console.log(failures ? `\n${failures} checks failed` : '\nAll checks passed')
process.exit(failures ? 1 : 0)
