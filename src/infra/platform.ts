/** Host-platform helpers: absolute-path shapes, executable lookup names, and shim naming, shared by setup and the worker environment. */
import { realpathSync } from 'node:fs'
import { delimiter, isAbsolute, resolve } from 'node:path'

/** True on Windows, where command lookup goes through PATHEXT and a shim is a `.cmd` batch file. */
export const isWindows = process.platform === 'win32'
/**
 * Shape of an absolute path on either platform: a POSIX `/…`, a Windows drive path `C:\…` or `C:/…`, or a UNC
 * `\\server\share`. The shape is deliberately platform-independent, so one saved configuration reads the same everywhere;
 * `assertNativeAbsolute` additionally requires this platform's own form where the path is actually used.
 */
export const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|[\\/])/
/**
 * Refuse a path that has an absolute shape but is not absolute on the running platform, naming the form expected here.
 * @throws when `value` is not a native absolute path.
 */
export function assertNativeAbsolute(key: string, value: string): void {
  if (!isAbsolute(value)) throw new Error(`${key} must be an absolute path for this platform (${isWindows ? 'C:\\…' : '/…'}), not ${JSON.stringify(value)}`)
}
/** Whether `name` is a bare command name rather than a path. */
export const isCommandName = (name: string): boolean => !/[\\/]/.test(name)
/**
 * The file names a bare command name may resolve to: on Windows the name with each `PATHEXT` extension appended, and on
 * POSIX the name alone. A name that already carries an extension is returned unchanged.
 */
export function executableNames(name: string): string[] {
  if (!isWindows || /\.[^\\/]+$/.test(name)) return [name]
  const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  return [name, ...extensions.map(extension => name + extension)]
}
/** The shim file name a command gets: `gh` on POSIX, and `gh.cmd` on Windows so `PATHEXT` resolves it. */
export const shimName = (name: string): string => isWindows ? `${name}.cmd` : name
/** Whether two paths name the same directory, resolving symbolic links when the path exists. */
export function sameDirectory(a: string, b: string): boolean {
  const real = (path: string): string => { try { return realpathSync(path) } catch { return resolve(path) } }
  return real(a) === real(b)
}
/** Remove one directory from a `PATH`-style list, keeping the others in order and the platform's separator. */
export function withoutDirectory(path: string, dir: string): string {
  return path.split(delimiter).filter(entry => !sameDirectory(entry, dir)).join(delimiter)
}
/** This process's environment as the strings a child process can receive, dropping unset entries. */
export function stringEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
}
