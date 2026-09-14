import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { PlatformSchema, VersionSchema } from '@dsh-ops/release-contract'
import { loadConfig } from '../server/config.js'
import { publishRelease } from '../server/publish.js'

const args = process.argv.slice(2).filter(arg => arg !== '--')
const { values } = parseArgs({ args, options: {
  version: { type: 'string' }, platform: { type: 'string' }, input: { type: 'string' }, notes: { type: 'string' },
  rollout: { type: 'string', default: '100' }, 'minimum-version': { type: 'string' }, config: { type: 'string' },
}, strict: true })
if (!values.input || !values.notes) throw new Error('Usage: --version 0.1.0 --platform windows-x64 --input /path/to/desktop-artifacts --notes content/development.json [--rollout 100] [--config /path/to/website.json]')
const config = await loadConfig(values.config)
const result = await publishRelease({
  root: config.releaseDirectory, input: path.resolve(values.input), version: VersionSchema.parse(values.version), platform: PlatformSchema.parse(values.platform),
  notes: JSON.parse((await readFile(values.notes, 'utf8')).replace(/^\uFEFF/, '')), rolloutPercentage: Number(values.rollout),
  ...(values['minimum-version'] ? { minimumVersion: values['minimum-version'] } : {}),
})
console.log(`Published ${result.version} (${values.platform}) to ${config.releaseDirectory}`)
