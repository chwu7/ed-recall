import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EdClient } from '../src/core/api.mjs';
import { toMarkdown } from '../src/core/content.mjs';
import { renderThread, parseArchive, writeThread } from '../src/archive.mjs';
import { SearchIndex } from '../src/index-db.mjs';
import { course, threadResponse } from './fixtures/ed.mjs';
export async function normalized(raw = threadResponse()) {
  return new EdClient({ token: 'fixture-token', interval: 0, sleep: async () => {}, fetchImpl: async () => Response.json(raw) }).thread(raw.thread.id);
}
test('conversion preserves code whitespace, fences, math, links, and unknown source', () => {
  const source = '<document><paragraph><bold>Policy</bold>: <link href="https://example.com">details</link> <math>x^2</math></paragraph><snippet language="python">if True:\n    print(&quot;```&quot;)</snippet><widget answer="42">Important fallback</widget></document>';
  const result = toMarkdown(source);
  assert.match(result.markdown, /\*\*Policy\*\*/); assert.match(result.markdown, /\[details\]\(https:\/\/example.com\/\)/);
  assert.ok(result.markdown.includes('$x^2$')); assert.ok(result.markdown.includes('    print("```")'));
  assert.ok(result.markdown.includes('````python')); assert.ok(result.markdown.includes('Important fallback'));
  assert.ok(result.warnings.some(w => w.includes('widget')));
  assert.ok(toMarkdown('<document><bad>').markdown.includes('<document><bad>'));
});
test('archive is readable and carries all metadata needed to rebuild reply hierarchy', async () => {
  const thread = await normalized(); const { markdown } = renderThread(thread, course); const restored = parseArchive(markdown);
  assert.equal(restored.nodes.length, 4); assert.equal(restored.nodes[3].parentId, 'comment:202');
  assert.equal(restored.nodes[1].role, 'staff'); assert.equal(restored.course.code, 'CS101');
  assert.ok(markdown.includes('#### Comment 203')); assert.ok(markdown.includes(thread.url));
});
test('FTS ranks useful passages, limits per-thread duplicates, handles punctuation, and rebuilds from Markdown', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ed-recall-search-'));
  const first = await normalized(); const second = await normalized(threadResponse(101)); second.title = 'Exam schedule'; second.post.content = 'The exam is Tuesday.'; second.post.children = [];
  await writeThread(dir, first, course); await writeThread(dir, second, course);
  const index = new SearchIndex(dir); t.after(async () => { index.close(); await rm(dir, { recursive: true, force: true }); });
  assert.equal(await index.reconcile(dir), 2);
  const results = index.search('Using ed-recall, what did staff say about late submissions? Cite the threads.');
  assert.ok(results.length > 0 && results.length <= 2); assert.equal(results[0].threadId, '100'); assert.ok(results[0].url.includes('/discussion/100'));
  assert.equal(index.search('" OR * - ( )').length, 0);
  assert.equal(index.search('exam', { courseId: '999' }).length, 0);
  assert.equal(index.thread('100').passages.length, 4);
  const context = index.context('late submissions', { maxChars: 100 });
  assert.ok(context.characters <= 100); assert.ok(context.passages[0].truncated); assert.ok(context.evidenceFound);
  assert.ok(!index.context('unfindablezz').evidenceFound);
  // A new SQLite file can recover the same passages without Ed or raw JSON.
  const copyDir = await mkdtemp(join(tmpdir(), 'ed-recall-rebuilt-'));
  const rebuilt = new SearchIndex(copyDir); t.after(async () => { rebuilt.close(); await rm(copyDir, { recursive: true, force: true }); });
  assert.equal(await rebuilt.reconcile(dir), 2); assert.deepEqual(rebuilt.search('late submissions'), index.search('late submissions'));
});
test('idempotent archive writes and edited comments replace old indexed evidence', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ed-recall-edit-'));
  const index = new SearchIndex(dir); t.after(async () => { index.close(); await rm(dir, { recursive: true, force: true }); });
  const thread = await normalized(); const initial = await writeThread(dir, thread, course); index.update(initial.archive);
  assert.equal((await writeThread(dir, thread, course)).changed, false);
  thread.post.children[1].children[0].content = 'The deadline is now Wednesdayxyz.';
  const updated = await writeThread(dir, thread, course); index.update(updated.archive);
  assert.equal(updated.changed, true); assert.equal(index.search('Wednesdayxyz')[0].passageId, 'comment:203');
  assert.equal(index.search('final homework').some(r => r.passageId === 'comment:203'), false);
  assert.ok((await readFile(updated.archive.path, 'utf8')).includes('Wednesdayxyz'));
});
