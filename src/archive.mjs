import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from './files.mjs';
import { toMarkdown } from './core/content.mjs';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');
const decode = text => JSON.parse(Buffer.from(text, 'base64').toString('utf8'));
const line = text => String(text ?? '').replace(/[\r\n\x00-\x1f\x7f]/g, ' ');
export function renderThread(thread, course) {
  const metadata = { schemaVersion: 1, id: thread.id, courseId: thread.courseId, number: thread.number, title: thread.title,
    url: thread.url, createdAt: thread.createdAt, updatedAt: thread.updatedAt, course };
  let output = `---\n${JSON.stringify(metadata, null, 2)}\n---\n\n# ${line(thread.title)}\n\nCourse: ${line(course.code)} — ${line(course.name)}\n\nThread: #${thread.number ?? '?'} · ID ${thread.id}\n\nSource: ${thread.url}\n\nCreated: ${thread.createdAt ?? 'unknown'} · Updated: ${thread.updatedAt ?? 'unknown'}\n`;
  const warnings = [];
  const visit = (node, depth, parentKey) => {
    const key = `${node.kind}:${node.id}`;
    const info = { id: key, sourceId: node.id, parentId: parentKey, kind: node.kind, depth, author: node.author, role: node.role,
      createdAt: node.createdAt, updatedAt: node.updatedAt, endorsed: node.endorsed, deleted: node.deleted };
    const converted = toMarkdown(node.content);
    warnings.push(...converted.warnings);
    output += `\n<!-- ed-recall-node:${encode(info)} -->\n${'#'.repeat(Math.min(depth + 2, 6))} ${node.kind === 'post' ? 'Original post' : node.kind === 'answer' ? 'Answer' : 'Comment'} ${node.id}${depth > 4 ? ` (depth ${depth})` : ''}\n\nBy ${line(node.author)}${node.role ? ` [${line(node.role)}]` : ''}${node.endorsed ? ' · Endorsed' : ''}${node.deleted ? ' · Deleted' : ''}\n\nCreated: ${node.createdAt ?? 'unknown'} · Updated: ${node.updatedAt ?? 'unknown'}\n\n${converted.markdown.replace(/<!-- ed-recall-node:/g, '&lt;!-- ed-recall-node:')}\n`;
    for (const child of node.children) visit(child, depth + 1, key);
  };
  visit(thread.post, 0, null);
  return { markdown: output, warnings: [...new Set(warnings)] };
}
export function parseArchive(markdown, path = '') {
  const header = markdown.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n/);
  if (!header) throw new Error(`Invalid archive metadata: ${path}`);
  const metadata = JSON.parse(header[1]);
  if (metadata.schemaVersion !== 1 || !metadata.id || !metadata.courseId || !metadata.url) throw new Error(`Unsupported archive: ${path}`);
  const markers = [...markdown.matchAll(/^<!-- ed-recall-node:([A-Za-z0-9+/=]+) -->\r?$/gm)];
  if (!markers.length) throw new Error(`No passage metadata: ${path}`);
  const nodes = markers.map((m, i) => ({ ...decode(m[1]), text: markdown.slice(m.index + m[0].length, markers[i + 1]?.index ?? markdown.length).trim(),
    line: markdown.slice(0, m.index).split('\n').length + 1 }));
  return { ...metadata, path, nodes, hash: createHash('sha256').update(markdown).digest('hex') };
}
export async function writeThread(dir, thread, course) {
  const path = join(dir, 'archive', thread.courseId, `${thread.id}.md`);
  const { markdown, warnings } = renderThread(thread, course);
  let old;
  try { old = await readFile(path, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (old !== markdown) await atomicWrite(path, markdown);
  return { archive: parseArchive(markdown, path), changed: old !== markdown, warnings };
}
export async function archiveFiles(dir) {
  const base = join(dir, 'archive');
  try { return (await readdir(base, { recursive: true })).filter(p => p.endsWith('.md')).sort().map(p => join(base, p)); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
