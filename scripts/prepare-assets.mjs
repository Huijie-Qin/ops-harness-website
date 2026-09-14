import { cp, mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const root = path.dirname(require.resolve('vditor/package.json'))
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
if (version !== '4.0.0') throw new Error('Review Vditor assets before changing the pinned version')
const target = path.resolve('public/assets/vendor/vditor-4.0.0')
// Only the editor engine, local language/icons and content theme are required.
for (const asset of ['dist/js/lute', 'dist/js/i18n/zh_CN.js', 'dist/js/icons/ant.js', 'dist/css/content-theme', 'dist/js/highlight.js/styles/github.min.css', 'LICENSE']) {
  await mkdir(path.dirname(path.join(target, asset)), { recursive: true })
  await cp(path.join(root, asset), path.join(target, asset), { recursive: true, dereference: false, filter: source => !source.endsWith('.map') })
}
