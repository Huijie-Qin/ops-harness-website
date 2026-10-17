import { parseArgs } from 'node:util'
import { loadConfig } from '../server/config.js'
import { ExpertStore } from '../server/expert-store.js'

// Read only: list the Skills of drafts and published experts the current Skill rules refuse (2026-10-16: a name with a
// line break after it, a camelCase switch, an unreadable switch value — DSH skips such a Skill without a word), and say
// whether uploading the same file again repairs it. Run before a client update reaches people:
//   pnpm skills:audit [-- --config /path/to/website.json] [--json]
const args = process.argv.slice(2).filter(arg => arg !== '--')
const { values } = parseArgs({ args, options: { config: { type: 'string' }, json: { type: 'boolean', default: false } }, strict: true })
const config = await loadConfig(values.config)
const rows = await new ExpertStore(config.contentDirectory).auditSkills()
if (values.json) {
  console.log(JSON.stringify(rows, null, 2))
} else if (rows.length === 0) {
  console.log('所有专家（草稿与已发布版本）的技能都符合当前规则。')
} else {
  console.log(`${String(rows.length)} 处技能不符合当前规则：`)
  for (const row of rows) {
    const next = row.repairable ? '重新上传同一个文件即可自动修好' : row.needsName ? '重新上传，并按提示填写英文名' : '需要技能作者修改后再上传'
    console.log(`- ${row.expertId}（${row.where === 'draft' ? '草稿' : `已发布 ${row.where}`}）技能「${row.name}」：${row.problems.join('；')} → ${next}`)
  }
}
// Something to do: a check before a client update can tell without reading the output.
if (rows.length) process.exitCode = 1
