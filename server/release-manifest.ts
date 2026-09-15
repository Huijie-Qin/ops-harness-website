import { parseDocument, visit, isAlias, isCollection, isNode } from 'yaml'
import { z } from 'zod'
import { ArtifactSchema, VersionSchema } from '@dsh-ops/release-contract'
import { maxManifestBytes, type ReleaseManifest } from '../shared/admin.js'
import { GuideError } from './guide-store.js'
import { matchingArtifacts } from './publish.js'

export const ManifestInputSchema = z.object({
  name: z.string().max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/).refine(v => !v.includes('..')),
  content: z.string().min(1).refine(v => Buffer.byteLength(v) <= maxManifestBytes),
}).strict()

const FileSchema = z.object({ url: z.string().min(1).max(540), sha512: ArtifactSchema.shape.sha512, size: ArtifactSchema.shape.size })
const MetadataSchema = z.object({
  version: VersionSchema, files: z.array(FileSchema).min(1).max(8),
  path: z.string().optional(), sha512: ArtifactSchema.shape.sha512.optional(),
  // Web installers reference additional remote packages; this service only hosts full installers.
  packages: z.never().optional(),
})

function fileName(value: string) {
  // Accept the builder's basename or its URL-encoded equivalent, never a path or remote URL.
  return decodeURIComponent(value)
}

export function parseReleaseManifest(input: unknown): ReleaseManifest {
  if (input == null) throw new GuideError('MANIFEST_REQUIRED')
  try {
    const source = ManifestInputSchema.parse(input)
    const doc = parseDocument(source.content, { schema: 'core', uniqueKeys: true, strict: true })
    if (doc.errors.length || doc.warnings.length) throw new Error('Invalid YAML')
    let nodes = 0
    visit(doc, (_key, node, ancestors) => {
      if (++nodes > 512 || ancestors.length > 12 || isAlias(node) || isNode(node) && (node.tag || 'anchor' in node && node.anchor)) throw new Error('Unsupported YAML structure')
      if (isCollection(node) && node.items.length > 100) throw new Error('Oversized collection')
    })
    const metadata = MetadataSchema.parse(doc.toJS({ maxAliasCount: 0 }))
    const files = metadata.files.map(file => ArtifactSchema.parse({ name: fileName(file.url), size: file.size, sha512: file.sha512 }))
    if (new Set(files.map(f => f.name.toLowerCase())).size !== files.length) throw new Error('Duplicate file')
    for (const file of files) {
      if (Buffer.from(file.sha512, 'base64').toString('base64') !== file.sha512) throw new Error('Non-canonical hash')
    }
    const platform = files.some(f => f.name.endsWith('.exe')) ? 'windows-x64' : 'macos-arm64'
    if (matchingArtifacts(files.map(f => f.name), metadata.version, platform).length !== files.length ||
      files.filter(f => f.name.endsWith(platform === 'windows-x64' ? '.exe' : '.zip')).length !== 1 ||
      platform === 'windows-x64' && files.some(f => /(?:^|[ _-])(?:ia32|x86|armv7l)(?=[ ._-]|$)/i.test(f.name))) throw new Error('Unsupported platform or version')
    // Legacy top-level fields, when present, must describe the same entry as files[].
    if ((metadata.path === undefined) !== (metadata.sha512 === undefined)) throw new Error('Incomplete legacy metadata')
    if (metadata.path !== undefined && !files.some(f => f.name === fileName(metadata.path!) && f.sha512 === metadata.sha512)) throw new Error('Conflicting legacy metadata')
    return { ...source, version: metadata.version, platform, files }
  } catch { throw new GuideError('INVALID_MANIFEST') }
}
