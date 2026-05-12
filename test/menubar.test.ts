import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  getMenubarPaths,
  install,
  renderPlugin,
  shellSingleQuote,
  status,
  uninstall,
  MENUBAR_PLUGIN_FILENAME
} from '../src/menubar'

// Sandbox $HOME so the test never touches the real ~/SwiftBarPlugins. The
// homedir() call is what getMenubarPaths reads.
let tmpHome: string
let originalHome: string | undefined

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sshshot-menubar-test-'))
  originalHome = process.env.HOME
  process.env.HOME = tmpHome
  // node:os caches the homedir on some platforms; clear the spy each test.
  vi.spyOn(os, 'homedir').mockReturnValue(tmpHome)
})

afterEach(() => {
  process.env.HOME = originalHome
  vi.restoreAllMocks()
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

describe('shellSingleQuote', () => {
  it('wraps a simple string in single quotes', () => {
    expect(shellSingleQuote('foo')).toBe("'foo'")
  })

  it('escapes embedded single quotes via close-escape-reopen', () => {
    expect(shellSingleQuote("foo'bar")).toBe("'foo'\\''bar'")
  })

  it('does not interpret $ / backtick / $(...) / double-quote', () => {
    // These characters lose their meaning inside zsh single quotes — so we
    // expect them to round-trip verbatim. This is exactly why we use single
    // quotes for embedded literals (PATH, binary path, etc).
    expect(shellSingleQuote('$HOME')).toBe("'$HOME'")
    expect(shellSingleQuote('`whoami`')).toBe("'`whoami`'")
    expect(shellSingleQuote('$(rm -rf /)')).toBe("'$(rm -rf /)'")
    expect(shellSingleQuote('"x"')).toBe('\'"x"\'')
  })

  it('handles real-world PATH input (colons, spaces, hyphens)', () => {
    const path = '/opt/homebrew/bin:/usr/local/bin:/Users/foo bar/.local/bin'
    expect(shellSingleQuote(path)).toBe(
      "'/opt/homebrew/bin:/usr/local/bin:/Users/foo bar/.local/bin'"
    )
  })
})

describe('getMenubarPaths', () => {
  it('points at ~/SwiftBarPlugins with the expected filename', () => {
    const p = getMenubarPaths()
    expect(p.pluginDir).toBe(path.join(tmpHome, 'SwiftBarPlugins'))
    expect(p.pluginFile).toBe(path.join(tmpHome, 'SwiftBarPlugins', MENUBAR_PLUGIN_FILENAME))
  })
})

describe('renderPlugin', () => {
  it('embeds the provided binary path as a single-quoted zsh literal', () => {
    const out = renderPlugin({ sshshotBin: '/usr/local/bin/sshshot', pathPrefix: '/usr/local/bin' })
    expect(out).toContain("SSHSHOT='/usr/local/bin/sshshot'")
  })

  it('shell-escapes exotic chars in sshshotBin and pathPrefix', () => {
    // A maliciously-crafted PATH (or unusual user homedir with a quote)
    // shouldn't break the script or trigger command substitution. Single
    // quotes are zsh's strongest literal — nothing inside is interpreted.
    const out = renderPlugin({
      sshshotBin: "/foo'bar/sshshot",
      pathPrefix: '/path/with$dollar:/path/with`backtick'
    })
    expect(out).toContain("SSHSHOT='/foo'\\''bar/sshshot'")
    expect(out).toContain("export PATH='/path/with$dollar:/path/with`backtick'")
  })

  it('prepends the install-time PATH so subprocesses find node/pngpaste/ssh', () => {
    const out = renderPlugin({
      sshshotBin: 'sshshot',
      pathPrefix: '/Users/me/.nvm/versions/node/v24.0.0/bin:/opt/homebrew/bin:/usr/local/bin'
    })
    expect(out).toContain(
      "export PATH='/Users/me/.nvm/versions/node/v24.0.0/bin:/opt/homebrew/bin:/usr/local/bin'"
    )
  })

  it('preserves SwiftBar metadata comments at the top', () => {
    const out = renderPlugin({ sshshotBin: 'sshshot', pathPrefix: '/usr/local/bin' })
    expect(out.startsWith('#!/bin/zsh')).toBe(true)
    expect(out).toContain('<swiftbar.title>sshshot</swiftbar.title>')
    expect(out).toContain('<swiftbar.refresh>5s</swiftbar.refresh>')
  })

  it('wires every direct click-action to a real sshshot subcommand', () => {
    const out = renderPlugin({ sshshotBin: 'sshshot', pathPrefix: '/usr/local/bin' })
    // `restart` is intentionally NOT in this list — it's a composite of
    // stop+start in the plugin, not a real `sshshot restart` subcommand.
    for (const action of ['target', 'pause', 'resume', 'start', 'stop']) {
      expect(out).toContain(`"$SSHSHOT" ${action}`)
    }
  })

  it('restart handler composes stop + start', () => {
    const out = renderPlugin({ sshshotBin: 'sshshot', pathPrefix: '/usr/local/bin' })
    // Pull just the `restart)` case block and assert it contains both calls.
    const restartBlock = out.split('restart)')[1]?.split(';;')[0] ?? ''
    expect(restartBlock).toContain('"$SSHSHOT" stop')
    expect(restartBlock).toContain('"$SSHSHOT" start')
  })
})

describe('install + uninstall', () => {
  it('writes a runnable plugin and marks it executable', () => {
    if (process.platform !== 'darwin') {
      // On non-mac, install no-ops by design.
      const r = install()
      expect(r.installed).toBe(false)
      return
    }
    const r = install()
    expect(r.installed).toBe(true)
    expect(fs.existsSync(r.pluginFile)).toBe(true)
    const stat = fs.statSync(r.pluginFile)
    // owner-executable bit set
    expect(stat.mode & 0o100).toBeTruthy()
    const content = fs.readFileSync(r.pluginFile, 'utf-8')
    expect(content.startsWith('#!/bin/zsh')).toBe(true)
  })

  it('install is idempotent — second call overwrites cleanly', () => {
    if (process.platform !== 'darwin') return
    install()
    const r2 = install()
    expect(r2.installed).toBe(true)
    expect(fs.existsSync(r2.pluginFile)).toBe(true)
  })

  it('uninstall removes the plugin file', () => {
    if (process.platform !== 'darwin') return
    install()
    const r = uninstall()
    expect(r.removed).toBe(true)
    expect(fs.existsSync(r.pluginFile)).toBe(false)
  })

  it('uninstall is safe when nothing is installed', () => {
    if (process.platform !== 'darwin') return
    const r = uninstall()
    expect(r.removed).toBe(false)
    expect(r.message).toContain('Nothing to remove')
  })
})

// `sshshot status --json` is the machine-readable surface the plugin reads.
// We can't easily test the index.ts dispatcher in isolation (it talks to the
// process list), but we CAN assert the plugin embeds the right jq query
// against the documented schema. That's the contract.
describe('plugin JSON parsing contract', () => {
  it('reads running / paused / activeTarget / pid from status --json', () => {
    const out = renderPlugin({ sshshotBin: 'sshshot', pathPrefix: '/usr/local/bin' })
    expect(out).toContain('"$SSHSHOT" status --json')
    // jq queries for each field the JSON contract promises
    expect(out).toContain("jq -r '.running // false'")
    expect(out).toContain('jq -r \'.pid // ""\'')
    expect(out).toContain('jq -r \'.activeTarget // ""\'')
    expect(out).toContain("jq -r '.paused // false'")
  })
})

describe('status', () => {
  it('reports not-installed when no plugin file exists', () => {
    const s = status()
    expect(s.installed).toBe(false)
    expect(s.pluginFile).toBe(path.join(tmpHome, 'SwiftBarPlugins', MENUBAR_PLUGIN_FILENAME))
  })

  it('reports installed after install()', () => {
    if (process.platform !== 'darwin') return
    install()
    const s = status()
    expect(s.installed).toBe(true)
  })
})
