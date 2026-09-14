import MarkdownIt from 'markdown-it'

const md = new MarkdownIt({ html: false, linkify: true, typographer: false })
md.renderer.rules.fence = (tokens, index) => `<div class="code-container"><button type="button" class="markdown-copy">复制示例</button><pre><code>${md.utils.escapeHtml(tokens[index]!.content)}</code></pre></div>`
const defaultLink = md.renderer.rules.link_open
md.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  tokens[index]!.attrSet('rel', 'noopener noreferrer')
  return defaultLink ? defaultLink(tokens, index, options, env, renderer) : renderer.renderToken(tokens, index, options)
}
// Images are controlled site assets. Remote tracking pixels and data/SVG payloads stay text.
md.renderer.rules.image = (tokens, index) => {
  const token = tokens[index]!, src = String(token.attrGet('src') ?? '')
  const alt = md.utils.escapeHtml(token.content)
  if (!/^\/(?:assets\/[a-zA-Z0-9/_-]+|media\/[a-f0-9]{64})\.(?:png|jpe?g|webp)$/.test(src)) return `<span>${alt}</span>`
  return `<a href="${src}" target="_blank" rel="noopener noreferrer"><img src="${src}" alt="${alt}" loading="lazy" /></a>`
}
export function renderMarkdown(markdown: string): string { return md.render(markdown) }
