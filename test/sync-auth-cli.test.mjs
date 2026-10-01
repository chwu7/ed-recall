import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { Credentials, redact } from '../src/auth.mjs';
import { syncCourses, syncStatus } from '../src/sync.mjs';
import { SearchIndex } from '../src/index-db.mjs';
import { bindAccount, loadConfig, saveConfig, accountDir, lock } from '../src/files.mjs';
import { resolveCourse } from '../src/agent-cli.mjs';
import { installSkill } from '../src/skill.mjs';
import { course, threadResponse, comment } from './fixtures/ed.mjs';
import { EdClient, EdError } from '../src/core/api.mjs';
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
test('resume skips completed work, retries failed threads, and refresh revisits unchanged timestamps', async t => {
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
  assert.equal(result.fetched, 0); assert.deepEqual(calls, []); assert.deepEqual(result.skippedCourses, ['42']);
  result = await syncCourses({ client, dir, courses: [course], index, refresh: true });
  assert.deepEqual(calls, ['100', '101']); assert.equal(result.changed, 1); assert.ok(index.search('Wednesdayxyz').length);
  result = await syncCourses({ client, dir, courses: [course], index, refresh: true }); assert.equal(result.changed, 0);
  const expanded = threadResponse(); expanded.thread.comments[0].comments.push(comment(206, 'Additional nested reply newevidencexyz')); expanded.thread.reply_count++;
  records[100] = await normalized(expanded); records[102] = await normalized(threadResponse(102));
  result = await syncCourses({ client, dir, courses: [course], index, refresh: true });
  assert.equal(result.changed, 2); assert.equal(result.fetched, 3);
  assert.equal(index.thread('102').id, '102'); assert.equal(index.search('newevidencexyz')[0].passageId, 'comment:206');
});

test('normal sync skips recent courses without listing them, starts new courses, and refreshes stale courses', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ed-recall-cached-'));
  const index = new SearchIndex(dir); t.after(async () => { index.close(); await rm(dir, { recursive: true, force: true }); });
  const second = { ...course, id: '43' }, courses = [course, second];
  const records = { 100: await normalized(threadResponse()), 101: await normalized(threadResponse(101)) }; records[101].courseId = '43';
  const listed = [], fetched = [];
  const client = { async *threads(id) { listed.push(id); yield id === '42' ? '100' : '101'; }, async thread(id) { fetched.push(id); return records[id]; } };
  await syncCourses({ client, dir, courses: [course], index });
  listed.length = 0; fetched.length = 0;
  let result = await syncCourses({ client, dir, courses, index });
  assert.deepEqual(result.skippedCourses, ['42']); assert.deepEqual(listed, ['43', '43']); assert.deepEqual(fetched, ['101']);
  listed.length = 0; fetched.length = 0;
  result = await syncCourses({ client, dir, courses, index });
  assert.equal(result.fetched, 0); assert.deepEqual(result.skippedCourses, ['42', '43']); assert.deepEqual(listed, []);
  const state = JSON.parse(await readFile(join(dir, 'sync.json'), 'utf8'));
  state.courses['42'].startedAt = new Date(Date.now() - 25 * 3600000).toISOString();
  await writeFile(join(dir, 'sync.json'), JSON.stringify(state));
  assert.equal((await syncStatus(dir, ['42'])).needsSync, true);
  result = await syncCourses({ client, dir, courses, index, resumeOnly: true });
  assert.equal(result.fetched, 0); assert.deepEqual(listed, []);
  result = await syncCourses({ client, dir, courses, index });
  assert.deepEqual(result.skippedCourses, ['43']); assert.deepEqual(listed, ['42', '42']); assert.deepEqual(fetched, ['100']);
  assert.equal((await syncStatus(dir, ['42'])).needsSync, false);
});
test('live lock refuses a second writer and a dead process lock is recovered', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ed-recall-lock-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await lock(dir, () => assert.rejects(lock(dir, async () => {}), /writer/));
  await writeFile(join(dir, 'writer.lock'), '2147483647');
  assert.equal(await lock(dir, async () => 'recovered'), 'recovered');
});

test('transient failures automatically retry checkpoints with bounded attempts and durable failure details', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ed-recall-retry-'));
  const index = new SearchIndex(dir); t.after(async () => { index.close(); await rm(dir, { recursive: true, force: true }); });
  const records = { 100: await normalized(threadResponse()), 101: await normalized(threadResponse(101)) };
  let failuresLeft = 1; const calls = [], waits = [];
  const client = { async *threads() { yield '100'; yield '101'; }, async thread(id) {
    calls.push(id); if (id === '101' && failuresLeft-- > 0) throw new EdError('Server unavailable', 503, { retryable: true }); return records[id];
  } };
  let result = await syncCourses({ client, dir, courses: [course], index, sleep: async ms => waits.push(ms) });
  assert.deepEqual(calls, ['100', '101', '101']); assert.deepEqual(waits, [1000]);
  assert.equal(result.retries, 1); assert.equal(result.fetched, 2); assert.deepEqual(result.failures, []);
  assert.equal((await syncStatus(dir, ['42'])).needsSync, false);
  calls.length = 0; failuresLeft = Infinity;
  result = await syncCourses({ client, dir, courses: [course], index, refresh: true, sleep: async () => {} });
  assert.deepEqual(calls, ['100', '101', '101']); assert.equal(result.failures.length, 1);
  let status = await syncStatus(dir, ['42']);
  assert.equal(status.courses[0].completedThreads, 1); assert.equal(status.courses[0].totalThreads, 2);
  assert.deepEqual(status.courses[0].failures, result.failures);
  failuresLeft = 0; calls.length = 0;
  result = await syncCourses({ client, dir, courses: [course], index, resumeOnly: true });
  assert.deepEqual(calls, ['101']); assert.equal(result.resumed, 1);
  status = await syncStatus(dir, ['42']); assert.equal(status.courses[0].failures.length, 0);
  calls.length = 0;
  result = await syncCourses({ client, dir, courses: [course], index, resumeOnly: true });
  assert.deepEqual(calls, []); assert.deepEqual(result.skippedCourses, ['42']);
});

test('thread errors do not block other courses; authentication and rate limits halt without automatic restart', async t => {
  for (const status of [0, 401, 429]) {
    const dir = await mkdtemp(join(tmpdir(), 'ed-recall-failure-'));
    const index = new SearchIndex(dir); t.after(async () => { index.close(); await rm(dir, { recursive: true, force: true }); });
    const second = { ...course, id: '43' };
    const record = await normalized(threadResponse(101)); record.courseId = '43';
    const calls = [];
    const client = { async *threads(courseId) { yield courseId === '42' ? '100' : '101'; }, async thread(id) {
      calls.push(id); if (id === '100') throw new EdError('Persistent failure', status); return record;
    } };
    const result = await syncCourses({ client, dir, courses: [course, second], index });
    assert.deepEqual(calls, status ? ['100'] : ['100', '101']); assert.equal(result.retries, 0);
    assert.equal(result.failures[0].threadId, '100');
    assert.equal((await syncStatus(dir, ['42'])).courses[0].failures[0].status, status);
  }
});

test('a killed process resumes its batch, recovers its lock, and skips committed threads and finished courses', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ed-recall-killed-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const courses = [course, { ...course, id: '43' }, { ...course, id: '44' }];
  const records = {};
  for (const id of ['100', '101', '102', '103']) records[id] = await normalized(threadResponse(id));
  records[101].courseId = records[102].courseId = '43'; records[103].courseId = '44';
  const state = { version: 1, courses: Object.fromEntries(courses.map(c => [c.id, { complete: true, completed: [], lastSuccessAt: new Date().toISOString() }])) };
  await writeFile(join(dir, 'sync.json'), JSON.stringify(state));
  const legacy = await syncStatus(dir, courses.map(c => c.id));
  assert.ok(legacy.courses.every(c => c.completedThreads === null && c.totalThreads === null));
  const source = `
    import { lock } from ${JSON.stringify(new URL('../src/files.mjs', import.meta.url).href)};
    import { syncCourses } from ${JSON.stringify(new URL('../src/sync.mjs', import.meta.url).href)};
    import { SearchIndex } from ${JSON.stringify(new URL('../src/index-db.mjs', import.meta.url).href)};
    const dir = ${JSON.stringify(dir)}, courses = ${JSON.stringify(courses)}, records = ${JSON.stringify(records)};
    const client = { async *threads(id) { for (const key of id === '42' ? ['100'] : id === '43' ? ['101','102'] : ['103']) yield key; },
      async thread(id) { if (id === '102') { console.log('READY'); await new Promise(() => { setInterval(() => {}, 1000); }); } return records[id]; } };
    await lock(dir, async () => { const index = new SearchIndex(dir); try { await syncCourses({ client, dir, courses, index }); } finally { index.close(); } });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`Child did not checkpoint: ${stderr}`)), 10000);
    child.stdout.on('data', data => { if (String(data).includes('READY')) { clearTimeout(timer); resolveReady(); } });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Child exited before interruption: ${stderr}`)); });
  });
  assert.equal((await syncStatus(dir, courses.map(c => c.id))).syncRunning, true);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const interrupted = await syncStatus(dir, courses.map(c => c.id));
  assert.equal(interrupted.syncRunning, false); assert.equal(interrupted.courses[0].incomplete, false);
  assert.equal(interrupted.courses[1].completedThreads, 1); assert.equal(interrupted.courses[2].incomplete, true);
  const calls = [];
  const client = { async *threads(id) { for (const key of id === '42' ? ['100'] : id === '43' ? ['101','102'] : ['103']) yield key; }, async thread(id) { calls.push(id); return records[id]; } };
  const result = await lock(dir, async () => { const index = new SearchIndex(dir); try { await index.reconcile(dir); return await syncCourses({ client, dir, courses, index }); } finally { index.close(); } });
  assert.deepEqual(calls, ['102', '103']); assert.equal(result.resumed, 1); assert.deepEqual(result.skippedCourses, ['42']);
  assert.equal((await syncStatus(dir, courses.map(c => c.id))).needsSync, false);
  const checkpoint = JSON.parse(await readFile(join(dir, 'sync.json'), 'utf8')); assert.deepEqual(checkpoint.pendingCourses, []);
});

test('unexplained reply counters complete sync with durable coverage warnings in archive and retrieval', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ed-recall-coverage-'));
  const index = new SearchIndex(dir); t.after(async () => { index.close(); await rm(dir, { recursive: true, force: true }); });
  const raw = threadResponse(); raw.thread.reply_count = 99;
  const record = await normalized(raw);
  const client = { async *threads() { yield '100'; }, async thread() { return record; } };
  const result = await syncCourses({ client, dir, courses: [course], index });
  assert.deepEqual(result.failures, []); assert.equal(result.warnings.length, 1);
  let status = await syncStatus(dir, ['42']);
  assert.equal(status.needsSync, false); assert.equal(status.coverageUncertain, true);
  assert.equal(status.courses[0].warnings[0].threadId, '100');
  assert.deepEqual(index.thread('100').warnings, record.warnings);
  assert.deepEqual(index.search('late submissions')[0].warnings, record.warnings);
  assert.deepEqual(index.context('late submissions').passages[0].warnings, record.warnings);
  assert.match(await readFile(join(dir, 'archive', '42', '100.md'), 'utf8'), /> Archive warning:/);
  const resumed = await syncCourses({ client, dir, courses: [course], index, resumeOnly: true });
  assert.equal(resumed.fetched, 0); assert.equal((await syncStatus(dir, ['42'])).coverageUncertain, true);
  record.warnings = []; await syncCourses({ client, dir, courses: [course], index, refresh: true });
  status = await syncStatus(dir, ['42']); assert.equal(status.coverageUncertain, false);
  assert.equal(index.thread('100').warnings, undefined);
});
test('agent JSON bridge, context, read and rebuild work with real local SQLite', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ed-recall-cli-')); t.after(() => rm(root, { recursive: true, force: true }));
  const config = await loadConfig(root);
  const account = await bindAccount(root, config, 'us', { userId: '7', courses: [course] }); account.selectedCourses = ['42']; await saveConfig(root, config);
  const dir = accountDir(root, config);
  const record = await normalized(threadResponse());
  await lock(dir, async () => { const index = new SearchIndex(dir); try { await syncCourses({ client: { async *threads() { yield '100'; }, async thread() { return record; } }, dir, courses: [course], index }); } finally { index.close(); } });
  const run = args => spawnSync(process.execPath, [resolve('bin/ed-recall.mjs'), '--data-dir', root, ...args], { encoding: 'utf8', env: { ...process.env, EDSTEM_TOKEN: '' } });
  for (const args of [['agent', 'status'], ['agent', 'list'], ['agent', 'search', 'late submissions'], ['agent', 'context', 'late submissions'], ['agent', 'read', '100']]) {
    const output = run(args); assert.equal(output.status, 0, output.stderr); assert.equal(JSON.parse(output.stdout).schemaVersion, 1);
  }
  assert.equal(JSON.parse(run(['agent', 'reindex']).stdout).indexedThreads, 1);
  assert.equal(JSON.parse(run(['agent', 'search', 'late']).stdout).results[0].threadId, '100');
  const invalid = run(['agent', 'search', 'late', '--limit', '-1']); assert.equal(invalid.status, 1); assert.ok(JSON.parse(invalid.stdout).error);
  assert.equal(run(['search', 'late']).status, 1);
  const unknown = run(['--secret-token', 'dont-echo-me']); assert.equal(unknown.status, 1); assert.ok(!unknown.stderr.includes('dont-echo-me'));
  const badResume = run(['agent', 'status', '--resume']); assert.equal(badResume.status, 1); assert.match(JSON.parse(badResume.stdout).error.message, /only supported/);
  const badRefresh = run(['agent', 'status', '--refresh']); assert.equal(badRefresh.status, 1); assert.match(JSON.parse(badRefresh.stdout).error.message, /only supported/);
  const conflicting = run(['agent', 'sync', '--resume', '--refresh']); assert.equal(conflicting.status, 1); assert.match(JSON.parse(conflicting.stdout).error.message, /either/);
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
