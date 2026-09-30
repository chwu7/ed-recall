import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Credentials, redact } from '../src/auth.mjs';
import { syncCourses, syncStatus } from '../src/sync.mjs';
import { SearchIndex } from '../src/index-db.mjs';
import { bindAccount, loadConfig, saveConfig, accountDir, lock } from '../src/files.mjs';
import { resolveCourse } from '../src/agent-cli.mjs';
import { installSkill } from '../src/skill.mjs';
import { course, threadResponse, comment } from './fixtures/ed.mjs';
import { EdClient } from '../src/core/api.mjs';
const normalized = async raw => new EdClient({ token: 'fixture-token', sleep: async () => {}, interval: 0, fetchImpl: async () => Response.json(raw) }).thread(raw.thread.id);
test('credential precedence, persistence, deletion and redaction use a mock store', async () => {
  let saved = 'stored-token';
  const entryFactory = async () => ({ getPassword: async () => saved, setPassword: async token => { saved = token; }, deleteCredential: async () => { saved = null; return true; } });
  const credentials = new Credentials('test', 'us', { env: { EDSTEM_TOKEN: 'env-token' }, entryFactory });
  assert.equal((await credentials.get()).source, 'environment');
  const local = new Credentials('test', 'us', { env: {}, entryFactory });
  assert.equal((await local.get()).token, 'stored-token');
  await local.save('new-token'); assert.equal(saved, 'new-token');
  assert.equal(redact('new-token env-token'), '[REDACTED] [REDACTED]');
  await local.logout(); assert.equal((await local.get()).source, 'none');
  const broken = new Credentials('test', 'us', { env: {}, entryFactory: async () => { throw new Error('backend raw secret'); } });
  await assert.rejects(broken.save('x'), e => !e.message.includes('backend raw secret'));
});
test('resume skips completed work, retries failed threads, then revisits unchanged timestamps on the next sync', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ed-recall-sync-'));
  const index = new SearchIndex(dir); t.after(async () => { index.close(); await rm(dir, { recursive: true, force: true }); });
  let fail = true; const calls = [];
  const records = { 100: await normalized(threadResponse()), 101: await normalized(threadResponse(101)) };
  const client = { async *threads() { for (const id of Object.keys(records)) yield id; }, async thread(id) { calls.push(id); if (id === '101' && fail) throw new Error('Simulated interrupted request'); return records[id]; } };
  let result = await syncCourses({ client, dir, courses: [course], index });
  assert.equal(result.failures.length, 1); assert.equal((await syncStatus(dir, ['42'])).courses[0].incomplete, true);
  fail = false; calls.length = 0;
  result = await syncCourses({ client, dir, courses: [course], index });
  assert.equal(result.resumed, 1); assert.deepEqual(calls, ['101']); assert.equal((await syncStatus(dir, ['42'])).needsSync, false);
  records[100].post.children[1].children[0].content = 'Nested amendment Wednesdayxyz'; calls.length = 0;
  result = await syncCourses({ client, dir, courses: [course], index });
  assert.deepEqual(calls, ['100', '101']); assert.equal(result.changed, 1); assert.ok(index.search('Wednesdayxyz').length);
  result = await syncCourses({ client, dir, courses: [course], index }); assert.equal(result.changed, 0);
  const expanded = threadResponse(); expanded.thread.comments[0].comments.push(comment(206, 'Additional nested reply newevidencexyz')); expanded.thread.reply_count++;
  records[100] = await normalized(expanded); records[102] = await normalized(threadResponse(102));
  result = await syncCourses({ client, dir, courses: [course], index });
  assert.equal(result.changed, 2); assert.equal(result.fetched, 3);
  assert.equal(index.thread('102').id, '102'); assert.equal(index.search('newevidencexyz')[0].passageId, 'comment:206');
});
test('live lock refuses a second writer and a dead process lock is recovered', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ed-recall-lock-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await lock(dir, () => assert.rejects(lock(dir, async () => {}), /writer/));
  await writeFile(join(dir, 'writer.lock'), '2147483647');
  assert.equal(await lock(dir, async () => 'recovered'), 'recovered');
});
test('agent JSON bridge, context, read and rebuild work with real local SQLite', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ed-recall-cli-')); t.after(() => rm(root, { recursive: true, force: true }));
  const config = await loadConfig(root);
  const account = await bindAccount(root, config, 'us', { userId: '7', courses: [course] }); account.selectedCourses = ['42']; await saveConfig(root, config);
  const dir = accountDir(root, config);
  const record = await normalized(threadResponse());
  await lock(dir, async () => { const index = new SearchIndex(dir); try { await syncCourses({ client: { async *threads() { yield '100'; }, async thread() { return record; } }, dir, courses: [course], index }); } finally { index.close(); } });
  const run = args => spawnSync(process.execPath, [resolve('bin/ed-recall.mjs'), '--data-dir', root, ...args], { encoding: 'utf8', env: { ...process.env, EDSTEM_TOKEN: '' } });
  for (const args of [['agent', 'status'], ['agent', 'search', 'late submissions'], ['agent', 'context', 'late submissions'], ['agent', 'read', '100']]) {
    const output = run(args); assert.equal(output.status, 0, output.stderr); assert.equal(JSON.parse(output.stdout).schemaVersion, 1);
  }
  assert.equal(JSON.parse(run(['agent', 'reindex']).stdout).indexedThreads, 1);
  assert.equal(JSON.parse(run(['agent', 'search', 'late']).stdout).results[0].threadId, '100');
  const invalid = run(['agent', 'search', 'late', '--limit', '-1']); assert.equal(invalid.status, 1); assert.ok(JSON.parse(invalid.stdout).error);
  assert.equal(run(['search', 'late']).status, 1);
  const unknown = run(['--secret-token', 'dont-echo-me']); assert.equal(unknown.status, 1); assert.ok(!unknown.stderr.includes('dont-echo-me'));
});
test('account switches do not carry course selection and ambiguous codes require IDs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ed-recall-account-')); t.after(() => rm(root, { recursive: true, force: true }));
  const config = await loadConfig(root); (await bindAccount(root, config, 'us', { userId: '1', courses: [course] })).selectedCourses = ['42'];
  const account = await bindAccount(root, config, 'us', { userId: '2', courses: [course] }); assert.deepEqual(account.selectedCourses, []);
  assert.throws(() => resolveCourse([course, { ...course, id: '43' }], 'CS101'), /ambiguous/);
});
test('skill installer is portable, idempotent and protects existing modifications', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ed-recall-skill-')); t.after(() => rm(home, { recursive: true, force: true }));
  for (const target of ['pi', 'codex', 'claude']) {
    const installed = await installSkill(target, { home }); assert.equal(installed.changed, true);
    if (target === 'codex') assert.equal(installed.path, join(home, '.agents', 'skills', 'ed-recall', 'SKILL.md'));
    assert.ok((await readFile(installed.path, 'utf8')).includes('answer') || (await readFile(installed.path, 'utf8')).includes('Answer'));
    assert.equal((await installSkill(target, { home })).changed, false);
    await writeFile(installed.path, 'custom'); await assert.rejects(installSkill(target, { home }), /already exists/);
    assert.equal((await installSkill(target, { home, force: true })).changed, true);
  }
});

test('Codex skill installer migrates the unchanged v0.1 location and protects customized copies', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ed-recall-codex-skill-')); t.after(() => rm(home, { recursive: true, force: true }));
  const legacy = join(home, '.codex', 'skills', 'ed-recall', 'SKILL.md');
  await mkdir(join(home, '.codex', 'skills', 'ed-recall'), { recursive: true });
  await writeFile(legacy, 'custom instructions');
  await assert.rejects(installSkill('codex', { home }), /older Codex skill differs/);
  assert.equal(await readFile(legacy, 'utf8'), 'custom instructions');
  await writeFile(legacy, await readFile(new URL('./fixtures/skill-v0.1.md', import.meta.url)));
  const result = await installSkill('codex', { home });
  assert.equal(result.migrated, true);
  assert.match(await readFile(result.path, 'utf8'), /ed-recall agent sync/);
  await assert.rejects(readFile(legacy), { code: 'ENOENT' });
});
