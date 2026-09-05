/**
 * Checks in a real browser: pen input, dots, automatic pages and — above all —
 * losing the connection and coming back.
 *
 * Needs Chrome installed and the client built (npm run build). If either is
 * missing the test says so and does not count as a failure.
 * Run with: npm run test:browser
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PORT = Number(process.env.PORT ?? 4398)
const CDP_PORT = Number(process.env.CDP_PORT ?? 9333)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const CHROME_PATHS = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean)

const chrome = CHROME_PATHS.find((p) => existsSync(p))
if (!chrome) {
  console.log('  skipped: Chrome not found (set its path in the CHROME variable)')
  process.exit(0)
}
if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
  console.log('  skipped: the client is not built — run "npm run build"')
  process.exit(0)
}

let failures = 0
const check = (ok, label) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`)
  if (!ok) failures++
}

const stateDir = await mkdtemp(join(tmpdir(), 'board-browser-'))
const profileDir = await mkdtemp(join(tmpdir(), 'board-chrome-'))
const children = []
const cleanup = async () => {
  for (const c of children) {
    try {
      c.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
  await rm(stateDir, { recursive: true, force: true })
  await rm(profileDir, { recursive: true, force: true })
}
process.on('exit', () => {
  for (const c of children) {
    try {
      c.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
})

/* ---------------- server ---------------- */

let server = null
const startServer = () =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], {
      env: { ...process.env, PORT: String(PORT), BOARD_KEY: 'test', BOARD_STATE_DIR: stateDir },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    children.push(child)
    child.stdout.on('data', (d) => {
      if (d.toString().includes('Host key')) resolve(child)
    })
    child.on('error', reject)
    setTimeout(() => reject(new Error('the server did not start')), 10000)
  })
const stopServer = async () => {
  if (!server) return
  const done = new Promise((r) => server.on('exit', r))
  server.kill('SIGTERM')
  await done
  server = null
}

/* ---------------- browser ---------------- */

const browser = spawn(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--disable-extensions',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--window-size=1600,1000',
    'about:blank',
  ],
  { stdio: 'ignore' },
)
children.push(browser)

let target = null
for (let i = 0; i < 40 && !target; i++) {
  await wait(400)
  try {
    const list = await (await fetch(`http://localhost:${CDP_PORT}/json/list`)).json()
    target = list.find((t) => t.type === 'page')
  } catch {
    /* not up yet */
  }
}
if (!target) {
  console.log('  skipped: could not attach to Chrome')
  await cleanup()
  process.exit(0)
}

server = await startServer()

const cdp = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 100 * 1024 * 1024 })
await new Promise((r) => cdp.on('open', r))
let msgId = 0
const pending = new Map()
const consoleErrors = []
cdp.on('message', (d) => {
  const m = JSON.parse(d.toString())
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result)
    pending.delete(m.id)
  }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)
  }
})
const send = (method, params = {}) =>
  new Promise((res) => {
    const id = ++msgId
    pending.set(id, res)
    cdp.send(JSON.stringify({ id, method, params }))
  })
const evalJs = async (expression) =>
  (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }))?.result
    ?.value

await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: 1600,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
})
await send('Page.addScriptToEvaluateOnNewDocument', {
  // Pin the language so the assertions below do not depend on the browser locale.
  source: `try { localStorage.clear(); localStorage.setItem('tb:lang', 'en') } catch {}`,
})
await send('Page.navigate', { url: `http://localhost:${PORT}/?key=test&name=Teacher` })
await wait(3000)

const status = () => evalJs(`document.querySelector('.status').textContent`)
const pageCount = () => evalJs(`document.querySelectorAll('.page-chip:not(.add)').length`)

const pen = (type, x, y, force, buttons = 1) =>
  send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: 'left',
    buttons,
    clickCount: 1,
    pointerType: 'pen',
    force,
  })
const key = async (k) => {
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', {
      type,
      key: k,
      code: `Key${k.toUpperCase()}`,
      text: type === 'keyDown' ? k : undefined,
      windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0),
    })
  }
  await wait(150)
}
const near = (a, b, eps = 0.01) => Math.abs(a - b) < eps

const drawLine = async (y) => {
  await pen('mousePressed', 700, y, 0.25)
  for (let i = 1; i <= 20; i++) {
    await pen('mouseMoved', 700 + i * 8, y + Math.sin(i / 3) * 10, 0.25 + 0.6 * Math.sin((i / 20) * Math.PI))
  }
  await pen('mouseReleased', 860, y, 0.1, 0)
  await wait(220)
}

/* ---------------- observer attached to the server ---------------- */

const observe = async (name = 'Observer') => {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`)
  const inbox = []
  await new Promise((r) => ws.on('open', r))
  ws.on('message', (d) => inbox.push(JSON.parse(d.toString())))
  const welcome = await new Promise((res) => {
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString())
      if (m.t === 'welcome') res(m)
    })
    ws.send(JSON.stringify({ t: 'hello', name }))
  })
  return { ws, inbox, welcome }
}

/* ---------------- checks ---------------- */

check((await status()) === 'Connected', 'the browser reached the local server')
check((await pageCount()) === 1, 'a clean board has one page')

// 1. A single pen tap must leave a dot.
// Coordinates stay inside the sheet: in the margins and gaps the pen is silent.
const watcher = await observe('Watcher')
await pen('mousePressed', 760, 400, 0.6)
await pen('mouseReleased', 760, 400, 0, 0)
await wait(400)
const dot = watcher.inbox.find((m) => m.t === 'op' && m.op?.el?.type === 'stroke')
check(!!dot, 'a single pen tap creates a stroke')
check(dot && dot.op.el.points.length === 3, `the dot holds exactly one coordinate (${dot?.op.el.points.length / 3})`)

// 2. Writing starts a page below.
await wait(300)
check((await pageCount()) === 2, 'a blank page appeared below after writing')

// 2a. Ribbon: sheets run one below another and scrolling changes the current one.
const wheel = (dy) =>
  send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: 900,
    y: 500,
    deltaX: 0,
    deltaY: dy,
    pointerType: 'mouse',
  })
const activeChip = () => evalJs(`document.querySelector('.page-chip.active')?.textContent`)

check((await activeChip()) === '1', 'before scrolling the first sheet is current')
// Scroll until the ribbon reaches the second sheet: a wheel notch depends on
// the zoom, so counting notches is not reliable.
let reachedSecond = false
for (let i = 0; i < 40 && !reachedSecond; i++) {
  await wheel(120)
  await wait(60)
  reachedSecond = (await activeChip()) === '2'
}
check(reachedSecond, `scrolling down made the second sheet current (${await activeChip()})`)

const ribbonWatch = await observe('Ribbon')
await drawLine(520)
await wait(500)
const onSecond = ribbonWatch.inbox.find((m) => m.t === 'op' && m.op?.el?.type === 'stroke')
const pagesNow = ribbonWatch.welcome.doc.pages
check(
  onSecond && pagesNow.findIndex((p) => p.id === onSecond.op.el.pageId) === 1,
  'a stroke on the scrolled ribbon landed on the second sheet, not the first',
)
if (onSecond) {
  const ys = []
  for (let i = 1; i < onSecond.op.el.points.length; i += 3) ys.push(onSecond.op.el.points[i])
  check(
    Math.min(...ys) >= 0 && Math.max(...ys) <= 1123,
    `coordinates count from their own sheet, not from the top of the ribbon (y ${Math.round(Math.min(...ys))}…${Math.round(Math.max(...ys))})`,
  )
}
ribbonWatch.ws.close()

// Go back to the first sheet through the pages bar, which scrolls the ribbon.
await evalJs(`document.querySelectorAll('.page-chip:not(.add)')[0].click(), 1`)
await wait(700)
check((await activeChip()) === '1', 'clicking a sheet number scrolls the ribbon to it')

// 3. Pen pressure reaches the document.
const before = watcher.inbox.length
await drawLine(500)
await wait(300)
const line = watcher.inbox.slice(before).find((m) => m.t === 'op' && m.op?.el?.type === 'stroke')
const pressures = []
if (line) for (let i = 2; i < line.op.el.points.length; i += 3) pressures.push(line.op.el.points[i])
check(new Set(pressures.map((p) => p.toFixed(2))).size > 5, `pen pressure was recorded (${new Set(pressures).size} values)`)
watcher.ws.close()

// 4. The partial eraser cuts a stroke instead of removing it whole.
const eraserWatch = await observe('Eraser')
await key('p')
await drawLine(760)
await wait(300)
const victim = eraserWatch.inbox.find((m) => m.t === 'op' && m.op?.el?.type === 'stroke')
check(!!victim, 'a stroke to erase was created')
const pointsBefore = victim?.op.el.points.length ?? 0

await key('e')
await evalJs(
  `[...document.querySelectorAll('.mode-row button')].find(b => b.textContent.includes('Part of it')).click(), 1`,
)
await wait(250)
const cutFrom = eraserWatch.inbox.length
await pen('mousePressed', 780, 700, 0.5)
await pen('mouseMoved', 780, 760, 0.5)
await pen('mouseMoved', 780, 820, 0.5)
await pen('mouseReleased', 780, 820, 0, 0)
await wait(500)

const after = eraserWatch.inbox.slice(cutFrom)
const updated = after.find((m) => m.t === 'op' && m.op?.t === 'update' && m.op.id === victim?.op.el.id)
const piece = after.find((m) => m.t === 'op' && m.op?.t === 'add' && m.op.el?.type === 'stroke')
const removedWhole = after.some((m) => m.t === 'op' && m.op?.t === 'remove' && m.op.ids.includes(victim?.op.el.id))
check(!!updated, 'the original stroke got shorter instead of vanishing')
check(!removedWhole, 'the partial eraser does not delete a whole object')
check(!!piece, 'a second piece split off the stroke')
const left = updated?.op.patch.points?.length ?? 0
const right = piece?.op.el.points.length ?? 0
check(left + right < pointsBefore, `the erased points are gone (${pointsBefore} → ${left + right})`)

// The "object" mode still removes everything whole.
await evalJs(
  `[...document.querySelectorAll('.mode-row button')].find(b => b.textContent.includes('Whole object')).click(), 1`,
)
await wait(250)
const wholeFrom = eraserWatch.inbox.length
await pen('mousePressed', 720, 760, 0.5)
await pen('mouseMoved', 900, 760, 0.5)
await pen('mouseReleased', 900, 760, 0, 0)
await wait(400)
check(
  eraserWatch.inbox.slice(wholeFrom).some((m) => m.t === 'op' && m.op?.t === 'remove'),
  'the "whole object" mode deletes objects',
)
eraserWatch.ws.close()

// 5. Pasting an image and text from the clipboard.
const pasteWatch = await observe('Paste')
const pasteImage = await evalJs(`(async () => {
  const c = document.createElement('canvas')
  c.width = 240; c.height = 160
  const g = c.getContext('2d')
  g.fillStyle = '#22c55e'; g.fillRect(0, 0, 240, 160)
  g.fillStyle = '#ffffff'; g.font = '28px sans-serif'; g.fillText('test', 24, 90)
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
  const dt = new DataTransfer()
  dt.items.add(new File([blob], 'shot.png', { type: 'image/png' }))
  window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }))
  return true
})()`)
check(pasteImage === true, 'the image paste event was dispatched')
await wait(1200)
const image = pasteWatch.inbox.find((m) => m.t === 'op' && m.op?.el?.type === 'image')
check(!!image, 'the pasted image landed on the board')
if (image) {
  const el = image.op.el
  check(el.src.startsWith('data:image/'), 'the image is stored in the document as a data URL')
  check(el.naturalW === 240 && el.naturalH === 160, `the source size was kept (${el.naturalW}×${el.naturalH})`)
  check(near(el.w / el.h, 240 / 160), 'the aspect ratio on the page is undistorted')
  check(el.w <= 794 && el.h <= 1123 && el.x >= 0 && el.y >= 0, 'the image fits on the sheet')
}
check(
  (await evalJs(`document.querySelector('.tool-btn.active')?.title`)).startsWith('Select'),
  'the select tool turns on after pasting, so the image can be moved at once',
)

const pasteText = await evalJs(`(() => {
  const dt = new DataTransfer()
  dt.setData('text/plain', 'Text pasted from the clipboard')
  window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }))
  return true
})()`)
check(pasteText === true, 'the text paste event was dispatched')
await wait(600)
const text = pasteWatch.inbox.find((m) => m.t === 'op' && m.op?.el?.type === 'text')
check(text?.op.el.text === 'Text pasted from the clipboard', 'pasted text became an object on the board')
check(text && text.op.el.fontSize > 0 && text.op.el.color, 'the pasted text has a font size and a color')
pasteWatch.ws.close()

// 6. Worst case: the connection drops, work continues, the connection returns.
await key('p')
const pagesOnline = await pageCount()
await stopServer()
await wait(1300)
check((await status()).startsWith('Offline'), `the client noticed the drop (${await status()})`)

await drawLine(620)
check((await pageCount()) === pagesOnline, 'writing on a sheet that is not the last adds no pages')

// Move to the last sheet: writing there must start the next one even offline.
await evalJs(`[...document.querySelectorAll('.page-chip:not(.add)')].at(-1).click(), 1`)
await wait(600)
await drawLine(500)
await wait(400)
check(
  (await pageCount()) === pagesOnline + 1,
  `writing on the last sheet offline started a new one (${pagesOnline} → ${await pageCount()})`,
)
check(/not sent/.test(await status()), `the unsent queue is counted (${await status()})`)
const pagesOffline = await pageCount()

server = await startServer()
let reconnected = false
for (let i = 0; i < 40; i++) {
  await wait(700)
  if ((await status()) === 'Connected') {
    reconnected = true
    break
  }
}
check(reconnected, 'the client reconnected on its own')
await wait(1000)
check((await status()) === 'Connected', 'the queue reached the server and nothing is left unsent')

const late = await observe('Late pupil')
const strokes = Object.values(late.welcome.doc.elements).filter((e) => e.type === 'stroke')
check(strokes.length >= 3, `the pupil sees everything, including what was drawn offline (${strokes.length} strokes)`)
const images = Object.values(late.welcome.doc.elements).filter((e) => e.type === 'image')
check(images.length === 1, 'the image survived the outage and stayed in the document')
// The point is that a page created offline is not duplicated: the server and
// the client give it the same name.
check(
  late.welcome.doc.pages.length === pagesOffline,
  `pages were restored without duplication (${pagesOffline} → ${late.welcome.doc.pages.length})`,
)
const emptyPages = late.welcome.doc.pages.filter(
  (p) => !Object.values(late.welcome.doc.elements).some((el) => el.pageId === p.id),
)
check(
  emptyPages.length === 1 && emptyPages[0].id === late.welcome.doc.pages.at(-1).id,
  `exactly one page is empty and it is the last (${emptyPages.length})`,
)
const pageIndex = (el) => late.welcome.doc.pages.findIndex((p) => p.id === el.pageId)
check(strokes.every((el) => pageIndex(el) >= 0), 'no stroke lost its page')
const usedPages = new Set(strokes.map(pageIndex))
check(usedPages.size >= 2, `strokes spread across several sheets (${[...usedPages].map((i) => i + 1).sort().join(', ')})`)
// A stroke may run past the bottom edge if it was dragged there, but it has to
// start on paper — coordinates count from its own sheet.
check(
  strokes.every((el) => el.points[1] >= 0 && el.points[1] <= 1123),
  `every stroke starts on its own sheet (${strokes.map((el) => Math.round(el.points[1])).join(', ')})`,
)
const lastPage = late.welcome.doc.pages.at(-1).id
check(!strokes.some((el) => el.pageId === lastPage), 'a blank page still sits at the bottom')
late.ws.close()

check(
  consoleErrors.length === 0,
  consoleErrors.length ? `console errors: ${consoleErrors[0]}` : 'no console errors',
)

cdp.close()
await stopServer()
await cleanup()
console.log(failures ? `\n${failures} checks failed` : '\nAll checks passed')
process.exit(failures ? 1 : 0)
