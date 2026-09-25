import { cp, rm, lstat } from 'node:fs/promises'
await rm('dist/content/guide', { recursive: true, force: true })
await cp('content/guide', 'dist/content/guide', { recursive: true, dereference: false })
await rm('dist/content/media', { recursive: true, force: true })
try {
  const info = await lstat('content/media')
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid content/media directory')
  await cp('content/media', 'dist/content/media', { recursive: true, dereference: false })
} catch (error) { if (error.code !== 'ENOENT') throw error }
await cp(new URL('../docs/third-party/', import.meta.url), 'dist/third-party', { recursive: true, dereference: false })
