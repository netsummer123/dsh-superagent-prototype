import { describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { Config, executable, machineOf } from '../src/deployment.ts'
import { writeEnvironment, workerBin } from '../src/infra/environment.ts'
import { ABSOLUTE_PATH, assertNativeAbsolute, executableNames, isCommandName, isWindows, shimName, stringEnvironment } from '../src/infra/platform.ts'

const minimal = (overrides: Record<string, unknown> = {}) => ({ stateDir: '/srv/state', ...overrides })

describe('absolute path shapes', () => {
  it('accepts either platform\'s absolute form, so one saved configuration is portable', () => {
    for (const path of ['/srv/state', '/', 'C:\\state', 'C:/state', 'D:\\a b\\c', '\\\\server\\share']) {
      expect(ABSOLUTE_PATH.test(path), path).toBe(true)
    }
  })
  it('rejects a relative path and a home-relative one', () => {
    for (const path of ['relative/dir', './state', '~/dir', 'state', '']) {
      expect(ABSOLUTE_PATH.test(path), path).toBe(false)
    }
  })
})

describe('configuration schema', () => {
  it('requires a state directory in an absolute shape', () => {
    expect(() => Config({})).toThrow('stateDir')
    expect(() => Config(minimal({ stateDir: 'relative/dir' }))).toThrow()
    expect(() => Config(minimal({ stateDir: '~/dir' }))).toThrow()
  })
  it('reads the state directory the host can actually use', () => {
    const native = mkdtempSync(join(tmpdir(), 'platform-'))
    expect(machineOf(Config(minimal({ stateDir: native }))).stateDir).toBe(native)
  })
  it('refuses an absolute path in the other platform\'s form', () => {
    // The schema accepts both shapes; the running host needs its own, named in the message.
    const foreign = isWindows ? '/srv/state' : 'C:\\state'
    if (isWindows) {
      // `/srv/state` is absolute on Windows too (drive-relative), so only the POSIX-shaped refusal is provable there.
      expect(() => assertNativeAbsolute('stateDir', '/srv/state')).not.toThrow()
    } else {
      expect(() => machineOf(Config(minimal({ stateDir: foreign })))).toThrow(/must be an absolute path for this platform/)
    }
  })
})

describe('executable and shim names', () => {
  it('tells a command name from a path', () => {
    expect(isCommandName('gh')).toBe(true)
    expect(isCommandName('lark-cli')).toBe(true)
    expect(isCommandName('/usr/local/bin/gh')).toBe(false)
    expect(isCommandName('C:\\Program Files\\GitHub CLI\\gh.exe')).toBe(false)
  })
  it('resolves a bare name through PATHEXT on Windows only', () => {
    const names = executableNames('gh')
    if (isWindows) {
      expect(names[0]).toBe('gh')
      expect(names.some(name => /\.exe$/i.test(name))).toBe(true)
    } else {
      expect(names).toEqual(['gh'])
    }
    // A name that already has an extension is never extended again.
    expect(executableNames('gh.exe')).toEqual(['gh.exe'])
  })
  it('names a shim so the platform resolves it', () => {
    expect(shimName('gh')).toBe(isWindows ? 'gh.cmd' : 'gh')
  })
  it('finds a real command on PATH, trying PATHEXT extensions on Windows', () => {
    // The running node is the one command guaranteed to exist here; on Windows its name is `node.exe`.
    const directory = dirname(process.execPath)
    const name = basename(process.execPath).replace(/\.exe$/i, '')
    const found = executable(name, [directory, process.env.PATH ?? ''].join(delimiter))
    expect(found.toLowerCase()).toContain(basename(process.execPath).toLowerCase())
  })
})

describe('child environment', () => {
  it('keeps only the variables that have a string value', () => {
    const environment = stringEnvironment()
    expect(Object.values(environment).every(value => typeof value === 'string')).toBe(true)
    expect(environment.PATH ?? '').toBeTypeOf('string')
  })
})

describe('worker shims', () => {
  it('writes this platform\'s shim dialect, and accepts its own files again on the next start', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'platform-shims-'))
    const cli = isWindows ? 'C:\\tools\\gh.exe' : '/usr/local/bin/gh'
    const deployment = { stateDir, repository: 'acme/widgets', github: { cli, login: 'agent-bot', noreply: '' } }
    // A second run proves the marker of this dialect is recognized: a foreign file would be refused.
    await writeEnvironment(deployment, ['curl'])
    await writeEnvironment(deployment, ['curl'])
    const dir = workerBin(stateDir)
    const names = readdirSync(dir)
    expect(names).toContain(shimName('gh'))
    expect(names).toContain(shimName('curl'))
    const gh = readFileSync(join(dir, shimName('gh')), 'utf8')
    const blocked = readFileSync(join(dir, shimName('curl')), 'utf8')
    if (isWindows) {
      expect(gh.startsWith('@echo off')).toBe(true)
      expect(gh).toContain('%*')
      expect(blocked).toContain('exit /b 1')
    } else {
      expect(gh.startsWith('#!/bin/sh')).toBe(true)
      expect(gh).toContain('exec')
      expect(blocked).toContain('exit 1')
    }
    // The git configuration that binds the credential helper is written beside the shims either way.
    const gitconfig = readFileSync(join(stateDir, 'worker-gitconfig'), 'utf8')
    expect(gitconfig).toContain('credential "https://github.com"')
    expect(gitconfig).toContain('helper =')
  })
})
