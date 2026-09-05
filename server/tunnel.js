import { spawn } from 'node:child_process'

/**
 * Address of a Cloudflare quick tunnel as printed by cloudflared.
 *
 * A quick tunnel is always named from several words joined by hyphens, such as
 * calm-river-1234. Requiring a hyphen keeps service hosts out: the failure
 * message itself mentions https://api.trycloudflare.com/tunnel, and a looser
 * pattern happily announced that as the address of a tunnel that never opened.
 */
const QUICK_TUNNEL_URL = /https:\/\/(?!api\.)[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/i

/**
 * cloudflared reached the network but the quick-tunnel API did not answer.
 * Providers block trycloudflare.com fairly often, so this deserves its own
 * explanation rather than a bare timeout.
 */
export const BLOCKED_HINT = `  The network is not letting through Cloudflare quick tunnels: the address
  api.trycloudflare.com does not answer while the rest of the internet works.
  Providers block it regularly. What helps:

    · Tailscale Funnel — free, and the address stays the same between runs:
      install Tailscale, then run "tailscale funnel <port>" in another terminal
    · ngrok http <port> — free tier, needs an account
    · a named Cloudflare tunnel — needs a domain of your own
    · a VPN on the teacher's machine`

/** Lines of the log that hint at a blocked quick-tunnel API. */
export function looksBlocked(lines) {
  return lines.some((line) =>
    /failed to request quick tunnel|api\.trycloudflare\.com/i.test(line),
  )
}

export const installHint = (port) => `  cloudflared was not found. Install it with:

    macOS    brew install cloudflared
    Windows  winget install --id Cloudflare.cloudflared
    Linux    https://github.com/cloudflare/cloudflared/releases

  Any other tunnel works too — run "ngrok http ${port}" or
  "tailscale funnel ${port}" in another terminal.`

/**
 * Address handed out by localhost.run over an SSH reverse tunnel.
 *
 * Only lhr.life: the service greets you with links to admin.localhost.run and
 * its own docs, and a looser pattern announces those as the tunnel.
 */
const SSH_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.lhr\.life/i

/**
 * Runs a tunnel program and waits for it to print an address.
 *
 * The promise settles as soon as an address appears, or with an error — in
 * which case the board still works on the local network. The last lines of the
 * program's output travel with the result: without them a failure is a bare
 * timeout with nothing to act on.
 *
 * Every candidate address is checked with `verify` before it is announced.
 * Both services mention their own hosts in the greeting — cloudflared names
 * api.trycloudflare.com in its failure, localhost.run links to its dashboard —
 * and matching one of those had the board hand out a link that led nowhere.
 * Asking the address whether it serves this board settles the question for good.
 */
function spawnTunnel({ bin, args, pattern, provider, timeoutMs, verify, onLog, onExit }) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      resolve({
        url: null,
        provider,
        error: err.code === 'ENOENT' ? 'not-installed' : err.message,
        log: [],
        stop() {},
      })
      return
    }

    let settled = false
    let buffer = ''
    const tail = []
    const stop = () => {
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
    }
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ provider, log: tail, stop, child, ...result })
    }
    const timer = setTimeout(
      () => finish({ url: null, error: `${provider} did not report an address in time` }),
      timeoutMs,
    )

    const rejected = new Set()
    let checking = false
    const consider = async (url) => {
      if (settled || checking || rejected.has(url)) return
      checking = true
      const ok = verify ? await verify(url) : true
      checking = false
      if (settled) return
      if (ok) {
        finish({ url, error: null })
        return
      }
      // Not our board: forget this address and keep reading for the real one.
      rejected.add(url)
      buffer = buffer.split(url).join('')
    }

    const read = (chunk) => {
      const text = chunk.toString()
      onLog?.(text)
      for (const line of text.split('\n')) {
        // Strip the escape codes localhost.run uses to draw its QR block.
        const trimmed = line.replace(/\u001b\[[0-9;]*m/g, '').trim()
        if (trimmed) tail.push(trimmed)
      }
      while (tail.length > 12) tail.shift()
      buffer += text
      const match = buffer.match(pattern)
      if (match) void consider(match[0])
      // Keep only the tail: the address is printed once, then come the logs.
      if (buffer.length > 64000) buffer = buffer.slice(-8000)
    }
    child.stdout.on('data', read)
    child.stderr.on('data', read)

    child.on('error', (err) =>
      finish({ url: null, error: err.code === 'ENOENT' ? 'not-installed' : err.message }),
    )
    child.on('exit', (code, signal) => {
      // The tunnel may die after a successful start; that is not a failure to
      // launch but a drop, and it deserves a separate report.
      const wasRunning = settled
      finish({ url: null, error: `${provider} exited (code ${code ?? signal})` })
      if (wasRunning) onExit?.(code, signal, tail)
    })
  })
}

/** Cloudflare quick tunnel. Needs cloudflared installed. */
export function startTunnel(port, options = {}) {
  const {
    bin = process.env.CLOUDFLARED ?? 'cloudflared',
    timeoutMs = 45000,
    verify,
    onLog,
    onExit,
  } = options
  return spawnTunnel({
    bin,
    args: ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`],
    pattern: QUICK_TUNNEL_URL,
    provider: 'cloudflared',
    timeoutMs,
    verify,
    onLog,
    onExit,
  })
}

/**
 * Reverse SSH tunnel through localhost.run.
 *
 * Nothing has to be installed: ssh ships with macOS, Linux and Windows 10 and
 * later. That makes it the fallback of choice when Cloudflare quick tunnels are
 * blocked, which providers do fairly often.
 */
export function startSshTunnel(port, options = {}) {
  const {
    bin = process.env.SSH ?? 'ssh',
    host = 'nokey@localhost.run',
    knownHosts,
    timeoutMs = 45000,
    verify,
    onLog,
    onExit,
  } = options
  const args = [
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ServerAliveInterval=20',
    '-o',
    'ExitOnForwardFailure=yes',
  ]
  // Keep the throwaway host key out of the teacher's own known_hosts.
  if (knownHosts) args.push('-o', `UserKnownHostsFile=${knownHosts}`)
  args.push('-R', `80:localhost:${port}`, host)
  return spawnTunnel({
    bin,
    args,
    pattern: SSH_TUNNEL_URL,
    provider: 'localhost.run',
    timeoutMs,
    verify,
    onLog,
    onExit,
  })
}

export const PROVIDERS = ['cloudflare', 'ssh']

/**
 * Opens a public tunnel, falling back when the preferred way is unavailable.
 * `prefer` pins one provider instead of trying them in order.
 */
export async function openTunnel(port, { prefer, knownHosts, verify, onLog, onExit } = {}) {
  const order = prefer ? [prefer] : PROVIDERS
  const attempts = []
  for (const provider of order) {
    const tunnel =
      provider === 'ssh'
        ? await startSshTunnel(port, { knownHosts, verify, onLog, onExit })
        : await startTunnel(port, { verify, onLog, onExit })
    if (tunnel.url) return { ...tunnel, attempts }
    attempts.push(tunnel)
  }
  return { ...attempts[attempts.length - 1], attempts }
}
