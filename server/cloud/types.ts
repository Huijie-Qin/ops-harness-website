import type { z } from 'zod'
import type { InstanceStateSchema, InstanceStatusSchema } from '@dsh-ops/cloud-task-contract'

// The contract exports the schemas but not these inferred types; derive them locally instead of forking the package.
export type InstanceState = z.infer<typeof InstanceStateSchema>
export type InstanceStatus = z.infer<typeof InstanceStatusSchema>
