import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { listCourses } from '../src/course-list.mjs';
import { writeThread } from '../src/archive.mjs';
import { bindAccount, loadConfig, saveConfig, accountDir } from '../src/files.mjs';
import { EdClient } from '../src/core/api.mjs';
import { course, threadResponse } from './fixtures/ed.mjs';

const record = async (id, courseId, createdAt, updatedAt = null) => {
  const raw = threadResponse(id); raw.thread.course_id = Number(courseId);
  raw.thread.created_at = createdAt; raw.thread.updated_at = updatedAt;
  return new EdClient({ token: 'fixture-token', interval: 0, sleep: async () => {}, fetchImpl: async () => Response.json(raw) }).thread(id);
};

test('list joins selected course metadata, sync states and newest posted threads offline without changing local files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ed-recall-list-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const courses = [course, ...['43', '44', '45', '46'].map(id => ({ ...course, id, code: `CS${id}` }))];
  const config = await loadConfig(root);
  const account = await bindAccount(root, config, 'us', { userId: '7', courses });
  account.selectedCourses = ['42', '43', '44', '45'];
  // Exercise metadata recovery from the archive when a selected course is absent from /user's cached list.
  account.courses = courses.filter(c => c.id !== '43'); await saveConfig(root, config);
  const dir = accountDir(root, config);
  const now = new Date().toISOString(), stale = new Date(Date.now() - 25 * 3600000).toISOString();
  const newest = await record(100, '42', '2026-09-02T10:00:00Z');
  const edited = await record(101, '42', '2026-09-01T10:00:00Z', '2026-09-30T10:00:00Z');
  const tied = await record(102, '42', newest.createdAt);
  for (const item of [newest, edited, tied]) await writeThread(dir, item, course);
  const partial = await record(103, '43', '2026-09-03T10:00:00Z');
  partial.warnings = ['Reply coverage is uncertain.']; await writeThread(dir, partial, courses[1]);
  await writeThread(dir, await record(104, '44', '2026-09-04T10:00:00Z'), courses[2]);
  await writeThread(dir, await record(105, '46', '2026-09-05T10:00:00Z'), courses[4]);
  const failure = { courseId: '43', threadId: '999', message: 'Access denied', status: 403, retryable: false };
  await writeFile(join(dir, 'sync.json'), JSON.stringify({ version: 1, courses: {
    42: { complete: true, startedAt: now, lastSuccessAt: now, completed: [] },
    43: { complete: false, startedAt: now, lastSuccessAt: null, completed: ['103'], totalThreads: 2,
      failures: [failure], coverageWarnings: [{ threadId: '103', warning: partial.warnings[0] }] },
    44: { complete: true, startedAt: stale, lastSuccessAt: stale, completed: [] },
    46: { complete: true, startedAt: now, lastSuccessAt: now, completed: [] },
  } }));
  // An unusable index must not prevent this local overview from working.
  await writeFile(join(dir, 'index.sqlite'), 'deliberately invalid database');
  const paths = [join(root, 'config.json'), ...(await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))];
  const before = await Promise.all(paths.map(path => readFile(path)));
  const output = spawnSync(process.execPath, [resolve('bin/ed-recall.mjs'), 'agent', 'list', '--data-dir', root],
    { encoding: 'utf8', env: { ...process.env, EDSTEM_TOKEN: '' } });
  assert.equal(output.status, 0, output.stderr);
  const result = JSON.parse(output.stdout);
  assert.equal(result.schemaVersion, 1); assert.equal(result.configured, true);
  assert.equal(result.archivedThreads, 6); assert.equal(result.selectedArchivedThreads, 5);
  assert.deepEqual(result.courses.map(c => c.id), ['42', '43', '44', '45']);
  assert.deepEqual(result.courses.map(c => c.syncState), ['current', 'incomplete', 'stale', 'not-synced']);
  assert.deepEqual(result.courses.map(c => c.archivedThreads), [3, 1, 1, 0]);
  assert.equal(result.courses[0].latestThread.id, '102'); // Tie resolved deterministically by ID, not most recent edit.
  assert.equal(result.courses[0].latestThread.createdAt, newest.createdAt);
  assert.equal(result.courses[0].lastSuccessAt, now);
  assert.equal(result.courses[1].code, 'CS43'); assert.equal(result.courses[1].coverageUncertain, true);
  assert.deepEqual(result.courses[1].failures, [failure]); assert.equal(result.courses[1].completedThreads, 1);
  assert.equal(result.courses[3].lastSuccessAt, null); assert.equal(result.courses[3].latestThread, null);
  assert.equal(result.needsSync, true); assert.equal(result.coverageUncertain, true);
  assert.deepEqual(await Promise.all(paths.map(path => readFile(path))), before);
});

test('list handles missing setup, empty archives and unnamed selected courses', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ed-recall-list-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = spawnSync(process.execPath, [resolve('bin/ed-recall.mjs'), 'agent', 'list', '--data-dir', root],
    { encoding: 'utf8', env: { ...process.env, EDSTEM_TOKEN: '' } });
  assert.equal(output.status, 0, output.stderr); assert.equal(JSON.parse(output.stdout).configured, false);
  assert.deepEqual(JSON.parse(output.stdout).courses, []);
  const result = await listCourses(join(root, 'absent'), ['123']);
  assert.equal(result.archivedThreads, 0); assert.equal(result.courses[0].code, '123');
  assert.equal(result.courses[0].syncState, 'not-synced'); assert.equal(result.courses[0].latestThread, null);
  assert.deepEqual(await readdir(root), []);
});
