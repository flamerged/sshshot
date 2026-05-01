import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'

export interface SSHHost {
  name: string
  hostname?: string
  user?: string
}

export interface Config {
  remotes: string[]
  // Active target for the daemon. When set, the daemon switches to this remote
  // on its next poll cycle without restarting. Updated via `sshshot target <name>`.
  // Set to "local" to save screenshots locally instead of uploading.
  activeTarget?: string
  // When true, the daemon stays alive but skips processing screenshots —
  // clipboard isn't touched, no uploads happen. Toggled via
  // `sshshot pause` / `sshshot resume` / `sshshot toggle`. Designed for the
  // common "I want to take a screenshot for Slack/GitHub right now without
  // sshshot stomping my clipboard" case so the user doesn't have to stop +
  // restart + re-select target every time.
  paused?: boolean
}

// Allowed character set for remote names: alphanumerics plus `.`, `_`, `-`,
// `@`. The leading character must NOT be `-` so ssh can't take it as an
// option flag (`-oProxyCommand=…`) — even with the `--` spawn-separator
// in monitor.ts, rejecting at config-input time gives a clear UI error
// instead of an unparseable saved entry. Covers everything ssh accepts as
// a hostname or user@host expression (including IPv4 dotted-quads and
// config-file aliases like `prod-1`). An IPv6 literal in user@host form
// would need brackets — not currently supported by the picker; users with
// v6-only hosts can put them in `~/.ssh/config` under a name and
// reference the alias.
//
// The whitelist is stricter than necessary because no current code path
// interpolates a `remote` value into a remote shell string — pipeToRemote
// and getHomeDir pass it as a positional spawn arg with `--` separator.
// But a future refactor that builds an ssh-side command from `remote`
// (e.g. a `sshshot logs <remote>` feature) would inherit the whitelist
// as defense in depth. Cheaper to enforce now than to remember later.
const VALID_REMOTE_NAME_RE = /^[A-Za-z0-9._@][A-Za-z0-9._@-]*$/

export function isValidRemoteName(name: string): boolean {
  return VALID_REMOTE_NAME_RE.test(name)
}

export function getConfigDir(): string {
  return path.join(os.homedir(), '.config', 'sshshot')
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json')
}

// Single source of truth for the daemon's pid file path. Imported by both
// monitor.ts (writer) and index.ts (reader) to prevent the two from
// drifting if the location ever changes.
export function getPidFile(): string {
  return path.join(getConfigDir(), 'sshshot.pid')
}

// Throttle repeat warnings — the daemon calls loadConfig 5x/sec, so a
// persistent broken file would otherwise log the same line every 200ms.
// Tracking the last error string per category makes log spam stop after
// the first occurrence and resume only when the error message changes
// (e.g. the user partially fixes the file).
let lastReadErrorMessage: string | null = null
let lastParseErrorMessage: string | null = null

// mtime-gated config cache — the daemon's poll loop calls loadConfig 5x/sec
// just to pick up `sshshot target <name>` changes, but the file rarely
// actually changes. Stat-and-compare keeps disk reads + JSON.parse cost
// near zero on the steady-state hot path; the actual read+parse only fires
// when mtimeMs differs from the previous successful load. Saving via
// saveConfig invalidates the cache (sets cachedConfigMtime back to null).
let cachedConfig: Config | null = null
let cachedConfigMtime: number | null = null

export function loadConfig(): Config | null {
  const configPath = getConfigPath()

  // Stat first. If the file is gone, drop the cache and return null. If the
  // mtime matches what we last loaded, return the cached value without
  // re-reading or re-parsing.
  let stat: fs.Stats
  try {
    stat = fs.statSync(configPath)
  } catch {
    cachedConfig = null
    cachedConfigMtime = null
    return null
  }
  if (cachedConfig !== null && cachedConfigMtime === stat.mtimeMs) {
    return cachedConfig
  }

  let content: string
  try {
    content = fs.readFileSync(configPath, 'utf-8')
  } catch (err) {
    const msg = (err as Error).message
    if (msg !== lastReadErrorMessage) {
      process.stderr.write(`sshshot: could not read config at ${configPath}: ${msg}\n`)
      lastReadErrorMessage = msg
    }
    return null
  }
  lastReadErrorMessage = null
  try {
    const parsed = JSON.parse(content) as Config
    lastParseErrorMessage = null
    cachedConfig = parsed
    cachedConfigMtime = stat.mtimeMs
    return parsed
  } catch (err) {
    // The previous behavior was to throw, which crashed the daemon's poll
    // loop. With this guard the daemon falls back to its start-time target
    // (resolveActiveTarget treats null config as 'no override') and logs
    // a one-shot warning so the user can fix the file.
    const msg = (err as Error).message
    if (msg !== lastParseErrorMessage) {
      process.stderr.write(
        `sshshot: config at ${configPath} is not valid JSON (${msg}). ` +
          `Falling back to defaults; re-run 'sshshot' to recreate.\n`
      )
      lastParseErrorMessage = msg
    }
    // Don't cache a parse failure — every subsequent stat will re-attempt
    // until the user fixes the file, which is what we want for a transient
    // mid-write read.
    return null
  }
}

export function saveConfig(config: Config): void {
  const configPath = getConfigPath()
  const configDir = path.dirname(configPath)
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true })
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
  // Invalidate the load cache so the next loadConfig() picks up the value
  // we just wrote (in case mtime resolution rounded equal — rare on macOS,
  // where APFS gives ns-resolution stat, but cheap insurance).
  cachedConfig = null
  cachedConfigMtime = null
}

// Loader signature for Include directives. Given a raw path spec (which may
// be relative, contain `~`, or a basic `*`/`?` glob), return the contents
// of every file it resolves to. Empty array on no matches / unreadable.
// Tests inject a deterministic loader; the real loader uses fs.
export type SSHConfigIncludeLoader = (pathSpec: string) => string[]

// OpenSSH's documented Include nesting limit. A misconfigured include cycle
// will short-circuit at this depth instead of stack-overflowing the parser.
const MAX_INCLUDE_DEPTH = 16

// Pure parser, exported for tests. Takes the raw text of an ssh_config and
// returns the Host blocks (excluding wildcard patterns).
//
// `Host a b c` declares three aliases sharing the same block — we emit one
// SSHHost per alias so all of them show up in the auto-detect picker. The
// previous parser dropped b and c entirely, so users with shorthand aliases
// like `Host prod-1 prod` had to type the long form by hand.
//
// `Include <pathspec>` directives recursively pull in additional config
// files. Most modern setups (especially corp/devbox boxes that ship a
// `~/.ssh/config.d/*` drop-in dir) put almost all hosts in includes; without
// this support, first-run auto-detect appeared empty. `Match` blocks are
// skipped — they don't introduce new Host names, only conditionally apply
// to existing ones.
export function parseSSHConfig(content: string, loader?: SSHConfigIncludeLoader): SSHHost[] {
  return parseSSHConfigInner(content, loader ?? (() => []), 0)
}

// OpenSSH treats `#` as starting a line comment iff preceded by whitespace
// OR at start of line. A `#` inside a token (e.g. a hostname `prod#qa`)
// is part of the value, not a comment. Strip from there to end-of-line.
// Exported so tests can pin the exact tokenizer behavior.
export function stripSshConfigComment(line: string): string {
  return line.replace(/(^|\s)#.*$/, '$1').trimEnd()
}

function parseSSHConfigInner(
  content: string,
  loader: SSHConfigIncludeLoader,
  depth: number
): SSHHost[] {
  if (depth > MAX_INCLUDE_DEPTH) return []

  const lines = content.split('\n').map(stripSshConfigComment)
  const hosts: SSHHost[] = []
  // currentBlock is a list of host objects sharing one Host directive — all
  // are mutated together when we see HostName / User children. Match blocks
  // null this out so subsequent HostName/User lines don't leak into a Host
  // block that already finished.
  let currentBlock: SSHHost[] | null = null
  let inMatchBlock = false

  const flush = () => {
    if (currentBlock) {
      hosts.push(...currentBlock)
      currentBlock = null
    }
  }

  for (const line of lines) {
    const trimmed = line.trim()
    const lower = trimmed.toLowerCase()

    if (lower.startsWith('host ')) {
      flush()
      inMatchBlock = false
      const aliases = trimmed
        .slice(5)
        .trim()
        .split(/\s+/)
        .filter((n) => n.length > 0 && !n.includes('*') && !n.startsWith('!'))
      if (aliases.length > 0) {
        currentBlock = aliases.map((name) => ({ name }))
      }
    } else if (lower.startsWith('match ')) {
      // Skip the entire Match block — close the previous Host so its
      // HostName/User children don't get inherited.
      flush()
      inMatchBlock = true
    } else if (lower.startsWith('include ')) {
      flush()
      inMatchBlock = false
      // Multiple path specs can appear on one line, whitespace-separated.
      const specs = trimmed
        .slice(8)
        .trim()
        .split(/\s+/)
        .filter((s) => s.length > 0)
      for (const spec of specs) {
        for (const includedContent of loader(spec)) {
          hosts.push(...parseSSHConfigInner(includedContent, loader, depth + 1))
        }
      }
    } else if (currentBlock && !inMatchBlock) {
      if (lower.startsWith('hostname ')) {
        const hostname = trimmed.slice(9).trim()
        for (const h of currentBlock) h.hostname = hostname
      } else if (lower.startsWith('user ')) {
        const user = trimmed.slice(5).trim()
        for (const h of currentBlock) h.user = user
      }
    }
  }

  flush()
  return hosts
}

// Real-world Include loader: resolves the path spec against the filesystem,
// expanding `~` and treating relative paths as anchored at `~/.ssh/`. Basic
// glob expansion (`*`, `?`) is supported in the basename only — sufficient
// for the canonical `Include ~/.ssh/config.d/*` pattern. Unreadable files
// are silently skipped (the user's .ssh dir might have permission quirks).
export function makeFsIncludeLoader(home: string): SSHConfigIncludeLoader {
  return (spec: string): string[] => {
    let resolved = spec
    if (resolved.startsWith('~/')) {
      resolved = path.join(home, resolved.slice(2))
    }
    if (!path.isAbsolute(resolved)) {
      resolved = path.join(home, '.ssh', resolved)
    }

    let matches: string[]
    if (resolved.includes('*') || resolved.includes('?')) {
      const dir = path.dirname(resolved)
      const pattern = path.basename(resolved)
      const re = globToRegExp(pattern)
      try {
        matches = fs
          .readdirSync(dir)
          .filter((name) => re.test(name))
          .map((name) => path.join(dir, name))
      } catch {
        matches = []
      }
    } else {
      matches = [resolved]
    }

    const contents: string[] = []
    for (const file of matches) {
      try {
        contents.push(fs.readFileSync(file, 'utf-8'))
      } catch {
        // include target missing or unreadable; skip
      }
    }
    return contents
  }
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}

export function detectSSHRemotes(): SSHHost[] {
  const home = os.homedir()
  const sshConfigPath = path.join(home, '.ssh', 'config')

  if (!fs.existsSync(sshConfigPath)) {
    return []
  }

  return parseSSHConfig(fs.readFileSync(sshConfigPath, 'utf-8'), makeFsIncludeLoader(home))
}
