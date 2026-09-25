import type { CloudDatabase, TickResult } from './database.js'
import { describeFailure } from './errors.js'
import type { InstanceManager } from './instances.js'

export type SchedulerOptions = { idleStopMinutes: number; tickMs?: number; now?: () => number; log?: ((line: string) => void) | undefined }
export type SchedulerTick = TickResult & { ensured: string[]; stopped: string[] }

/**
 * Periodic control loop: fires due tasks into the run queue, recycles stale run and command leases, wakes instances
 * that have work (runs, commands, open sessions) and puts idle ones to sleep. Every step is isolated so one
 * orchestrator failure never stalls the loop.
 */
export class CloudScheduler {
  private timer: ReturnType<typeof setInterval> | undefined
  private running: Promise<SchedulerTick> | undefined
  private now: () => number
  constructor(private db: CloudDatabase, private instances: InstanceManager, private options: SchedulerOptions) { this.now = options.now ?? Date.now }
  tick(): Promise<SchedulerTick> {
    if (this.running) return this.running
    this.running = this.pass().finally(() => { this.running = undefined })
    return this.running
  }
  private async pass(): Promise<SchedulerTick> {
    const now = this.now()
    const advanced = this.db.advance(now)
    if (advanced.enqueued.length || advanced.requeued.length || advanced.failed.length || advanced.expired.length || advanced.commandsRequeued.length || advanced.commandsFailed.length) this.options.log?.(`tick enqueued=${advanced.enqueued.length} requeued=${advanced.requeued.length} failed=${advanced.failed.length} expired=${advanced.expired.length} commandsRequeued=${advanced.commandsRequeued.length} commandsFailed=${advanced.commandsFailed.length}`)
    const ensured: string[] = []
    // Pending runs, queued commands and open sessions all need the user's instance alive.
    for (const employeeId of this.db.employeesNeedingInstance()) {
      try { await this.instances.ensureRunning(employeeId); ensured.push(employeeId) }
      catch (error) { this.options.log?.(`ensure ${employeeId} failed: ${describeFailure(error)}`) }
    }
    // Instances without work still get a liveness check so a crash is recorded instead of lingering as starting/running.
    for (const record of this.db.listInstances()) {
      if (ensured.includes(record.employeeId) || (record.state !== 'starting' && record.state !== 'running')) continue
      try { await this.instances.refresh(record.employeeId) }
      catch (error) { this.options.log?.(`refresh ${record.employeeId} failed: ${describeFailure(error)}`) }
    }
    const stopped: string[] = []
    for (const employeeId of this.db.idleInstances(now - this.options.idleStopMinutes * 60_000)) {
      try { await this.instances.stop(employeeId); stopped.push(employeeId) }
      catch (error) { this.options.log?.(`stop ${employeeId} failed: ${describeFailure(error)}`) }
    }
    return { ...advanced, ensured, stopped }
  }
  start() {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick().catch(error => this.options.log?.(`tick failed: ${describeFailure(error)}`)), this.options.tickMs ?? 30_000)
    this.timer.unref()
  }
  async stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.running?.catch(() => {})
  }
}
