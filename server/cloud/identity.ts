import { EmployeeIdSchema } from '@dsh-ops/cloud-task-contract'

// The wire schema allows dots in real employee IDs. Dot path segments themselves
// cannot name an isolated instance home and must be rejected at the host boundary.
export const CloudEmployeeIdSchema = EmployeeIdSchema.refine(value => value !== '.' && value !== '..', 'employeeId must not be a relative path segment')

export function instanceEmployeeId(value: string): string {
  const parsed = CloudEmployeeIdSchema.parse(value)
  if (parsed !== value) throw new Error('instance employeeId must be normalized')
  return parsed
}
