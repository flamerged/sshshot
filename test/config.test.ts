import { describe, expect, it } from 'vitest'
import { isValidRemoteName, parseSSHConfig } from '../src/config'

describe('parseSSHConfig', () => {
  it('returns empty array for empty input', () => {
    expect(parseSSHConfig('')).toEqual([])
  })

  it('parses a single host with hostname + user', () => {
    const input = `Host my-host
  HostName 1.2.3.4
  User myuser
  Port 22
`
    expect(parseSSHConfig(input)).toEqual([
      { name: 'my-host', hostname: '1.2.3.4', user: 'myuser' }
    ])
  })

  it('parses multiple hosts', () => {
    const input = `Host alpha
  HostName a.example.com
  User alice

Host beta
  HostName b.example.com
  User bob
`
    expect(parseSSHConfig(input)).toEqual([
      { name: 'alpha', hostname: 'a.example.com', user: 'alice' },
      { name: 'beta', hostname: 'b.example.com', user: 'bob' }
    ])
  })

  it('skips wildcard host patterns', () => {
    const input = `Host *.example.com
  User everyone

Host real-host
  HostName 5.6.7.8
`
    expect(parseSSHConfig(input)).toEqual([{ name: 'real-host', hostname: '5.6.7.8' }])
  })

  it('handles hosts without hostname (uses name as resolution target)', () => {
    const input = `Host minimal
`
    expect(parseSSHConfig(input)).toEqual([{ name: 'minimal' }])
  })

  it('is case-insensitive for keywords', () => {
    const input = `host my-host
  hostname 1.2.3.4
  USER root
`
    expect(parseSSHConfig(input)).toEqual([{ name: 'my-host', hostname: '1.2.3.4', user: 'root' }])
  })

  it('expands multi-alias Host lines into one SSHHost per alias', () => {
    const input = `Host primary alias-1 alias-2
  HostName 1.2.3.4
  User shared
`
    // All aliases share the same hostname/user — each becomes selectable.
    expect(parseSSHConfig(input)).toEqual([
      { name: 'primary', hostname: '1.2.3.4', user: 'shared' },
      { name: 'alias-1', hostname: '1.2.3.4', user: 'shared' },
      { name: 'alias-2', hostname: '1.2.3.4', user: 'shared' }
    ])
  })

  it('drops wildcard / negation entries from a mixed Host line', () => {
    const input = `Host * !forbidden real
  User shared
`
    // The block is kept (the 'real' alias is non-wildcard); '*' and '!forbidden'
    // are filtered out.
    expect(parseSSHConfig(input)).toEqual([{ name: 'real', user: 'shared' }])
  })

  it('ignores unrelated directives', () => {
    const input = `Host my-host
  HostName 1.2.3.4
  IdentityFile ~/.ssh/id_ed25519
  ProxyJump bastion
  ForwardAgent yes
`
    expect(parseSSHConfig(input)).toEqual([{ name: 'my-host', hostname: '1.2.3.4' }])
  })

  it('handles indented and non-indented entries equivalently', () => {
    const input = `Host my-host
HostName 1.2.3.4
   User space-indented
\tUser tab-indented-overwrites
`
    expect(parseSSHConfig(input)).toEqual([
      { name: 'my-host', hostname: '1.2.3.4', user: 'tab-indented-overwrites' }
    ])
  })

  it('does not crash on stray comments and blank lines', () => {
    const input = `# Hetzner production fleet

Host hetzner-1
  HostName 5.6.7.8
  User deploy

# Below: spare boxes
Host hetzner-2
  HostName 9.10.11.12
`
    expect(parseSSHConfig(input)).toEqual([
      { name: 'hetzner-1', hostname: '5.6.7.8', user: 'deploy' },
      { name: 'hetzner-2', hostname: '9.10.11.12' }
    ])
  })

  it('expands Include directives via the loader', () => {
    const root = `Host primary
  HostName 1.2.3.4

Include corp_config
`
    const corp = `Host corp-bastion
  HostName bastion.corp
  User ops
`
    const loader = (spec: string): string[] => (spec === 'corp_config' ? [corp] : [])
    expect(parseSSHConfig(root, loader)).toEqual([
      { name: 'primary', hostname: '1.2.3.4' },
      { name: 'corp-bastion', hostname: 'bastion.corp', user: 'ops' }
    ])
  })

  it('handles multiple path specs on one Include line', () => {
    const root = `Include first second
`
    const first = `Host a
  HostName a.example.com
`
    const second = `Host b
  HostName b.example.com
`
    const loader = (spec: string): string[] => {
      if (spec === 'first') return [first]
      if (spec === 'second') return [second]
      return []
    }
    expect(parseSSHConfig(root, loader)).toEqual([
      { name: 'a', hostname: 'a.example.com' },
      { name: 'b', hostname: 'b.example.com' }
    ])
  })

  it('caps Include recursion depth instead of stack-overflowing on cycles', () => {
    // Self-referential include: file A includes itself. Without the depth
    // cap this would recurse indefinitely.
    const fileA = `Host a
  HostName a.example.com

Include selfref
`
    const loader = (spec: string): string[] => (spec === 'selfref' ? [fileA] : [])
    const result = parseSSHConfig(fileA, loader)
    // Each recursion level emits the `a` host once; depth cap stops the loop.
    // We don't assert exact count — just that it terminated and only emitted
    // the one expected host name.
    expect(result.length).toBeGreaterThan(0)
    expect(result.every((h) => h.name === 'a')).toBe(true)
  })

  it('skips Match blocks (no Host names emitted from them)', () => {
    const input = `Host plain
  HostName plain.example.com

Match host *.dev
  ForwardAgent yes
  HostName dev.example.com
`
    expect(parseSSHConfig(input)).toEqual([{ name: 'plain', hostname: 'plain.example.com' }])
  })
})

describe('isValidRemoteName', () => {
  it('accepts ordinary hostnames', () => {
    expect(isValidRemoteName('myhost')).toBe(true)
    expect(isValidRemoteName('prod-1')).toBe(true)
    expect(isValidRemoteName('user@host.example.com')).toBe(true)
    expect(isValidRemoteName('192.168.1.1')).toBe(true)
  })

  it('rejects names that ssh would parse as flags', () => {
    expect(isValidRemoteName('-oProxyCommand=evil.sh')).toBe(false)
    expect(isValidRemoteName('-l')).toBe(false)
    expect(isValidRemoteName('-')).toBe(false)
  })

  it('rejects empty / whitespace / control characters', () => {
    expect(isValidRemoteName('')).toBe(false)
    expect(isValidRemoteName('host with space')).toBe(false)
    expect(isValidRemoteName('host\twith\ttab')).toBe(false)
    expect(isValidRemoteName('host\nwith\nnewline')).toBe(false)
  })
})
