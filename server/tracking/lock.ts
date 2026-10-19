import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, fsyncSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/** A stale lock is deliberately not stolen: operators must fence the old writer first. */
export function acquireTrackingLock(directory: string, purpose: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (lstatSync(directory).isSymbolicLink()) throw new Error('UNSAFE_ANALYTICS_PATH')
  const file = path.join(directory, '.tracking.lock'), token = randomUUID()
  let fd: number
  try { fd = openSync(file, 'wx', 0o600) } catch { throw new Error('ANALYTICS_LOCKED') }
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token, purpose, createdAt: new Date().toISOString() })); fsyncSync(fd) }
  finally { closeSync(fd) }
  // Persist the lock's directory entry before starting any writer. A power loss
  // must leave a stale lock requiring fencing, rather than silently admitting a
  // new writer while an old remote INSERT could still be running.
  for (let parent = path.resolve(directory); process.platform !== 'win32'; parent = path.dirname(parent)) {
    const parentFd = openSync(parent, 'r'); try { fsyncSync(parentFd) } finally { closeSync(parentFd) }
    if (path.dirname(parent) === parent) break
  }
  return () => {
    if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).token === token) {
      unlinkSync(file)
      if (process.platform !== 'win32') { const parentFd = openSync(directory, 'r'); try { fsyncSync(parentFd) } finally { closeSync(parentFd) } }
    }
  }
}
