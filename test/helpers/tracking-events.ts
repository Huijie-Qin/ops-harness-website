import { randomUUID } from 'node:crypto'
import type { TrackingEvent } from '@dsh-ops/tracking-contract'
import type { Installation } from '../../server/tracking/types.js'
export const installation = (): Installation => ({ tenantId: 'development', installationId: randomUUID(), environment: 'test' })
export function event(i: Installation, extra: Partial<TrackingEvent> = {}): TrackingEvent {
  return { schemaVersion: 1, eventVersion: 1, eventId: randomUUID(), eventName: 'operation.accepted', module: 'tool-market', feature: 'tools', action: 'tool.add', occurredAt: new Date().toISOString(), installationId: i.installationId, runtimeId: randomUUID(), sequence: 1, initiator: 'user', interactionId: randomUUID(), operationId: randomUUID(), platform: 'win32', appVersion: '0.1.0', environment: i.environment, properties: {}, employee: { source: 'welink', employeeId: 'test-person' }, ...extra }
}
