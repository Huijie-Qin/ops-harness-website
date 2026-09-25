import path from 'node:path'
import type { WebsiteConfig } from '../config.js'
import { ArtifactStore } from './artifacts.js'
import { CloudDatabase } from './database.js'
import { describeFailure } from './errors.js'
import { createCloudHandlers } from './http.js'
import { InstanceManager } from './instances.js'
import { DockerOrchestrator, ProcessOrchestrator, type Orchestrator } from './orchestrator.js'
import { CloudScheduler } from './scheduler.js'

export type CloudRuntime = {
  db: CloudDatabase; instances: InstanceManager; scheduler: CloudScheduler; artifacts: ArtifactStore
  maintain(): Promise<void>; close(): Promise<void>
}
export type CloudRuntimeOptions = { log?: ((line: string) => void) | undefined; now?: () => number; orchestrator?: Orchestrator }

/** Assemble database, orchestrator, instance manager, scheduler and artifact store for an enabled `cloud` config. */
export async function createCloudRuntime(config: Pick<WebsiteConfig, 'cloud' | 'websiteUrl'>, options: CloudRuntimeOptions = {}): Promise<CloudRuntime> {
  const { cloud } = config
  const db = new CloudDatabase(cloud.directory, options.now)
  const orchestrator = options.orchestrator ?? (cloud.orchestrator === 'docker'
    ? new DockerOrchestrator({ ...cloud.docker, directory: cloud.directory })
    : new ProcessOrchestrator({ ...cloud.process, directory: cloud.directory, log: options.log }))
  const instances = new InstanceManager(db, orchestrator, {
    instanceWebsiteUrl: cloud.orchestrator === 'docker' ? cloud.docker.websiteUrlForInstances ?? config.websiteUrl : config.websiteUrl,
    modelApiKeyEnv: cloud.modelApiKeyEnv, log: options.log, ...(options.now ? { now: options.now } : {}),
  })
  const artifacts = new ArtifactStore(path.join(cloud.directory, 'artifacts'))
  await artifacts.initialize()
  const scheduler = new CloudScheduler(db, instances, { idleStopMinutes: cloud.idleStopMinutes, log: options.log, ...(options.now ? { now: options.now } : {}) })
  // Reconcile instances recorded as live by a previous website process with what the backend actually has.
  for (const record of db.listInstances()) if (record.state !== 'stopped' && record.state !== 'error') await instances.refresh(record.employeeId)
  return {
    db, instances, scheduler, artifacts,
    async maintain() {
      for (const runId of db.maintain()) await artifacts.remove(runId).catch(error => options.log?.(`artifact cleanup ${runId} failed: ${describeFailure(error)}`))
    },
    async close() {
      await scheduler.stop()
      await orchestrator.close().catch(error => options.log?.(`orchestrator close failed: ${describeFailure(error)}`))
      db.close()
    },
  }
}
export { createCloudHandlers }
