import { XMLParser, XMLBuilder, XMLValidator } from 'fast-xml-parser';
const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, trimValues: false, parseTagValue: false, processEntities: true, htmlEntities: true });
const builder = new XMLBuilder({ preserveOrder: true, ignoreAttributes: false });
const textOnly = nodes => nodes.map(n => '#text' in n ? String(n['#text']) : textOnly(n[Object.keys(n).find(k => k !== ':@')] ?? [])).join('');
const fence = (text, language = '') => {
  const size = Math.max(3, ...Array.from(text.matchAll(/`+/g), m => m[0].length + 1));
  const ticks = '`'.repeat(size);
  return `\n\n${ticks}${language.replace(/[^\w+-]/g, '')}\n${text}\n${ticks}\n\n`;
};
const escape = text => text.replace(/([\\`*_\[\]<>])/g, '\\$1');
const safeLink = url => {
  try { const u = new URL(url); return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? u.href.replace(/\(/g, '%28').replace(/\)/g, '%29') : null; } catch { return null; }
};
export function toMarkdown(content) {
  const warnings = [];
  if (!content.trimStart().startsWith('<')) return { markdown: content, warnings };
  if (/<!DOCTYPE|<!ENTITY|<!--|<!\[CDATA\[/i.test(content) || XMLValidator.validate(content) !== true) return { markdown: `Unconverted Ed content (unsupported or invalid XML):${fence(content, 'xml')}`, warnings: ['Unsupported or invalid XML preserved verbatim.'] };
  const render = (nodes, depth = 0) => nodes.map(node => {
    if ('#text' in node) return escape(String(node['#text']));
    const tag = Object.keys(node).find(k => k !== ':@');
    const children = node[tag] ?? []; const attrs = node[':@'] ?? {};
    const body = () => render(children, depth + 1);
    const raw = () => textOnly(children);
    if (depth > 100) { warnings.push('Deep XML preserved.'); return fence(builder.build([node]), 'xml'); }
    switch (tag) {
      case 'document': return body();
      case 'paragraph': case 'p': return `\n\n${body()}\n\n`;
      case 'heading': return `\n\n${'#'.repeat(Math.min(6, Math.max(1, Number(attrs['@_level']) || 2)))} ${body()}\n\n`;
      case 'bold': case 'strong': return `**${body()}**`;
      case 'italic': case 'em': return `*${body()}*`;
      case 'code': return '`'.repeat(Math.max(1, ...Array.from(raw().matchAll(/`+/g), m => m[0].length + 1))) + ' ' + raw() + ' ' + '`'.repeat(Math.max(1, ...Array.from(raw().matchAll(/`+/g), m => m[0].length + 1)));
      case 'pre': case 'snippet': return fence(raw(), attrs['@_language'] ?? '');
      case 'math': return attrs['@_display'] === 'block' || raw().includes('\n') ? `\n\n$$\n${raw()}\n$$\n\n` : `$${raw()}$`;
      case 'link': { const url = safeLink(attrs['@_href']); if (url) return `[${body().trim()}](${url})`; break; }
      case 'image': { const url = safeLink(attrs['@_src']); if (url) return `![${escape(attrs['@_alt'] ?? 'Ed image')}](${url})`; break; }
      case 'file': { const url = safeLink(attrs['@_url']); if (url) return `[${body().trim() || 'Attachment'}](${url})`; break; }
      case 'figure': return `\n\n${body()}\n\n`;
      case 'br': case 'break': return '\n';
      case 'list': return '\n\n' + children.map((n, i) => n['list-item'] ? `${attrs['@_style'] === 'number' ? `${i + 1}.` : '-'} ${render(n['list-item'], depth + 1).trim().replace(/\n/g, '\n    ')}` : render([n], depth + 1)).join('\n') + '\n\n';
      case 'blockquote': case 'callout': return `\n\n${body().trim().split('\n').map(l => `> ${l}`).join('\n')}\n\n`;
    }
    warnings.push(`Unsupported element <${tag}> preserved as XML.`);
    return `\n\nUnconverted Ed element:${fence(builder.build([node]), 'xml')}`;
  }).join('');
  return { markdown: render(parser.parse(content)).trim(), warnings: [...new Set(warnings)] };
}
