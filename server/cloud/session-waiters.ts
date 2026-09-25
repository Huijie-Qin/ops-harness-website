import type { ServerResponse } from 'node:http'

/**
 * Long-poll registry for `GET sessions/:id/events`: a reader parks until the session changes (new frames, state or
 * cancel flag), its wait budget runs out, or the client goes away. Wake-ups carry no data; the reader re-queries.
 */
export class SessionWaiters {
  private waiters = new Map<string, Set<() => void>>()
  private count = 0
  constructor(private maxWaiting = 512) {}
  get size() { return this.count }
  /** Resolve `false` immediately when the registry is full so the caller answers without waiting. */
  wait(sessionId: string, ms: number, res: ServerResponse): Promise<boolean> {
    if (this.count >= this.maxWaiting) return Promise.resolve(false)
    return new Promise(resolve => {
      const set = this.waiters.get(sessionId) ?? new Set<() => void>()
      this.waiters.set(sessionId, set)
      const wake = () => {
        if (!set.delete(wake)) return
        if (set.size === 0) this.waiters.delete(sessionId)
        clearTimeout(timer)
        res.off('close', wake)
        this.count -= 1
        resolve(true)
      }
      const timer = setTimeout(wake, ms)
      timer.unref()
      set.add(wake)
      this.count += 1
      res.on('close', wake)
    })
  }
  notify(sessionId: string) {
    const set = this.waiters.get(sessionId)
    if (!set) return
    for (const wake of [...set]) wake()
  }
  /** Release every parked reader (website shutdown). */
  close() { for (const set of [...this.waiters.values()]) for (const wake of [...set]) wake() }
}
