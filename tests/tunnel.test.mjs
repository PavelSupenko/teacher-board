/**
 * Checks for the public tunnel. A real cloudflared is not needed: stand-in
 * scripts imitate how it behaves in different situations.
 * Run with: npm run test:tunnel
 */
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startTunnel, startSshTunnel, installHint, looksBlocked } from '../server/tunnel.js'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (ok, label) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`)
  if (!ok) failures++
}

const dir = await mkdtemp(join(tmpdir(), 'tunnel-test-'))
const fake = async (name, body) => {
  const path = join(dir, name)
  await writeFile(path, `#!/bin/sh\n${body}\n`, 'utf8')
  await chmod(path, 0o755)
  return path
}

const ADDRESS = 'https://calm-river-1234.trycloudflare.com'

// 1. normal start: the address is printed to stderr among other logs
const ok = await fake(
  'ok',
  `echo "INF Thank you for trying Cloudflare Tunnel." >&2
sleep 0.2
echo "INF |  Your quick Tunnel has been created! Visit it at:  |" >&2
echo "INF |  ${ADDRESS}  |" >&2
sleep 30`,
)
const logs = []
const t1 = await startTunnel(4321, { bin: ok, onLog: (s) => logs.push(s) })
check(t1.url === ADDRESS, `the tunnel address was parsed from the output (${t1.url})`)
check(t1.error === null, 'no error reported')
check(logs.join('').includes('Thank you'), "cloudflared's output reaches the caller")
check(t1.log.length > 0, 'the last lines of the log are kept on the result')

const exited = new Promise((r) => t1.child.on('exit', r))
t1.stop()
await exited
check(t1.child.killed || t1.child.exitCode !== null, 'stop() terminates cloudflared')

// 1a. The failure message mentions the service host; it is not an address.
const decoy = await fake(
  'decoy',
  `echo "INF Requesting new quick Tunnel on trycloudflare.com..." >&2
echo 'failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": context deadline exceeded' >&2
exit 1`,
)
const t1b = await startTunnel(4321, { bin: decoy })
check(t1b.url === null, `api.trycloudflare.com from an error is not taken for a tunnel (${t1b.url})`)
check(/code 1/.test(t1b.error ?? ''), 'the failure is reported as a failure')
check(
  t1b.log.some((line) => /failed to request quick Tunnel/.test(line)),
  "cloudflared's own words are kept for the report",
)
check(looksBlocked(t1b.log), 'a blocked quick-tunnel API is recognised')
check(!looksBlocked(['INF Thank you for trying Cloudflare Tunnel.']), 'ordinary logs are not mistaken for a block')

// 1b. A stale address in the output must not be taken for the live tunnel.
const STALE = 'https://old-tunnel-name.trycloudflare.com'
const noisy = await fake(
  'noisy',
  `echo "INF previous run was ${STALE}" >&2
sleep 0.2
echo "INF ${ADDRESS}" >&2
sleep 30`,
)
const seen = []
const t1c = await startTunnel(4321, {
  bin: noisy,
  // Only the live tunnel answers for this board.
  verify: async (url) => {
    seen.push(url)
    return url === ADDRESS
  },
})
check(t1c.url === ADDRESS, `the stale address was rejected and the live one taken (${t1c.url})`)
check(seen[0] === STALE && seen.length === 2, `every candidate is checked once (${seen.join(', ')})`)
t1c.stop()

// 1c. If nothing verifies, the attempt fails rather than announcing a bad link.
const onlyDecoy = await fake('decoy2', `echo "INF ${STALE}" >&2\nsleep 30`)
const t1d = await startTunnel(4321, { bin: onlyDecoy, timeoutMs: 900, verify: async () => false })
check(t1d.url === null, 'an address that does not serve the board is never announced')
t1d.stop()

// 1d. localhost.run advertises its own dashboard; that is not the tunnel.
const LHR = 'https://f91d38a751c261.lhr.life'
const sshFake = await fake(
  'ssh',
  `echo "To set up and manage custom domains go to https://admin.localhost.run/" >&2
echo "see https://localhost.run/docs/ for more information" >&2
sleep 0.2
echo "f91d38a751c261.lhr.life tunneled with tls termination, ${LHR}" >&2
sleep 30`,
)
const t1e = await startSshTunnel(4321, { bin: sshFake, verify: async () => true })
check(t1e.url === LHR, `the dashboard link was skipped, the tunnel taken (${t1e.url})`)
check(t1e.provider === 'localhost.run', 'the provider is reported')
t1e.stop()

// 2. cloudflared is not installed
const t2 = await startTunnel(4321, { bin: join(dir, 'no-such-file') })
check(t2.url === null && t2.error === 'not-installed', 'a missing cloudflared is reported separately')
check(installHint(4321).includes('brew install cloudflared'), 'the install hint carries a command')
check(installHint(9999).includes('ngrok http 9999'), 'the hint fills in the real port')

// 3. cloudflared died immediately
const boom = await fake('boom', 'echo "failed" >&2\nexit 3')
const t3 = await startTunnel(4321, { bin: boom })
check(t3.url === null && /code 3/.test(t3.error ?? ''), `a crash at start-up is reported (${t3.error})`)

// 4. no address appeared, and we do not wait forever
const silent = await fake('silent', 'echo "INF just logs" >&2\nsleep 30')
const started = Date.now()
const t4 = await startTunnel(4321, { bin: silent, timeoutMs: 600 })
check(t4.url === null && /in time/.test(t4.error ?? ''), 'waiting for the address is bounded by a timeout')
check(Date.now() - started < 2000, 'the timeout fires on schedule')
t4.stop()

// 5. the tunnel dropped after a successful start
const flaky = await fake('flaky', `echo "INF ${ADDRESS}" >&2\nsleep 0.4\nexit 1`)
let exitReported = false
const t5 = await startTunnel(4321, { bin: flaky, onExit: () => { exitReported = true } })
check(t5.url === ADDRESS, 'the address arrived before the drop')
await wait(900)
check(exitReported, 'a drop after a successful start is reported separately')

await rm(dir, { recursive: true, force: true })
console.log(failures ? `\n${failures} checks failed` : '\nAll checks passed')
process.exit(failures ? 1 : 0)
