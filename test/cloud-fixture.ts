import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { TestContext } from 'node:test'
import type { WebsiteConfig } from '../server/config.js'
import { createCloudRuntime, type CloudRuntime } from '../server/cloud/index.js'
import type { InstanceEnvironment, Orchestrator, OrchestratorState } from '../server/cloud/orchestrator.js'

/** In-memory orchestrator: records calls and the environment each launch received. */
export class FakeOrchestrator implements Orchestrator {
  readonly backend = 'process' as const
  calls: string[] = []
  states = new Map<string, OrchestratorState>()
  environments = new Map<string, InstanceEnvironment>()
  failNext: Error | undefined
  /** What the next launch reports (a process backend reports `starting` until the readiness line). */
  launchState: OrchestratorState | undefined
  async ensureRunning(employeeId: string, env: InstanceEnvironment): Promise<OrchestratorState> {
    this.calls.push(`ensure:${employeeId}`)
    if (this.failNext) { const error = this.failNext; this.failNext = undefined; throw error }
    this.environments.set(employeeId, env)
    const state: OrchestratorState = this.launchState ? { ...this.launchState } : { state: 'running', backendRef: `fake-${employeeId}`, port: 3400 }
    this.states.set(employeeId, state)
    return state
  }
  async stop(employeeId: string) { this.calls.push(`stop:${employeeId}`); this.states.set(employeeId, { state: 'stopped' }) }
  async inspect(employeeId: string): Promise<OrchestratorState> { return this.states.get(employeeId) ?? { state: 'stopped' } }
  async close() { this.calls.push('close') }
}

export const START = Date.parse('2026-09-25T00:00:00.000Z')

export function cloudConfig(directory: string, overrides: Partial<WebsiteConfig['cloud']> = {}): WebsiteConfig['cloud'] {
  return {
    enabled: true, directory, orchestrator: 'process', idleStopMinutes: 15, executorPollMs: 1000, modelApiKeyEnv: 'DSH_OPS_CLOUD_TEST_MODEL_KEY',
    docker: { socketPath: '/nonexistent/docker.sock', image: 'dsh-ops-cloud:test', memoryMb: 2048, cpus: 1, network: 'bridge', instancePort: 3080, extraHosts: [], sandbox: 'native' },
    process: { productRepo: '', dshEntry: '', overlays: [], nodeExecutable: '', portRangeStart: 3400 },
    ...overrides,
  }
}

export async function cloudFixture(t: TestContext, overrides: Partial<WebsiteConfig['cloud']> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'website-cloud-'))
  let time = START
  const clock = { now: () => time, set: (value: number) => { time = value }, advance: (ms: number) => { time += ms } }
  const orchestrator = new FakeOrchestrator()
  const runtime: CloudRuntime = await createCloudRuntime({ cloud: cloudConfig(path.join(root, 'cloud'), overrides), websiteUrl: 'http://127.0.0.1:4173' }, { orchestrator, now: clock.now })
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }) })
  return { root, clock, orchestrator, runtime, db: runtime.db }
}

export const definition = (overrides: Record<string, unknown> = {}) => ({
  name: '每日晨报', description: '汇总昨日运营数据', expertId: 'product-default', skillNames: ['daily-brief'], prompt: '请生成昨日运营晨报并保存为 report.md',
  schedule: { kind: 'interval', everyMinutes: 60, anchorAt: new Date(START).toISOString() }, timeoutMinutes: 30, ...overrides,
})
