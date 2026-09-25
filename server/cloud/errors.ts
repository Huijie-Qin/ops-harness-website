import type { CloudErrorCode } from '@dsh-ops/cloud-task-contract'

/** Error surfaced to API clients as `{ error, message? }` with a contract error code; never carries stacks or secrets. */
export class CloudError extends Error {
  constructor(public code: CloudErrorCode, public status = 400, message?: string) { super(message ?? code) }
}

/** Trim an unknown failure to a short diagnostic string safe for `last_error` and logs (no stacks, no env). */
export function describeFailure(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return text.replace(/\s+/g, ' ').slice(0, 500)
}
