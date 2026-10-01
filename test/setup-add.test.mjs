import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Credentials } from '../src/auth.mjs';
import { authenticateSetup } from '../src/setup-auth.mjs';
import { bindAccount, loadConfig, accountDir } from '../src/files.mjs';
import { writeThread } from '../src/archive.mjs';
import { EdClient, EdError } from '../src/core/api.mjs';
import { course, threadResponse, userResponse } from './fixtures/ed.mjs';

const identity = { userId: '7', courses: [course] };
const unexpected = async () => { throw new Error('Unexpected prompt'); };
function setupHarness(saved = 'saved-fixture-token', env = {}) {
  const writes = [], reads = [], validated = [], notices = [];
  const credentials = new Credentials('fixture-root', 'us', { env, entryFactory: async () => ({
    getPassword: async () => { reads.push(true); return saved; },
    setPassword: async token => { writes.push(token); saved = token; },
  }) });
  const options = { root: 'fixture-root', region: 'us', credentials, choose: unexpected, prompt: unexpected,
    replaceInvalid: unexpected, notify: text => notices.push(text),
    createClient: ({ token, region }) => ({ user: async () => { validated.push({ token, region }); return identity; } }) };
  return { options, writes, reads, validated, notices, saved: () => saved };
}

test('setup defaults to reusing a saved token without requesting or rewriting it', async () => {
  const h = setupHarness();
  h.options.choose = async prompt => {
    assert.equal(prompt.default, 'reuse'); assert.deepEqual(prompt.choices.map(c => c.value), ['reuse', 'replace']); return 'reuse';
  };
  assert.deepEqual(await authenticateSetup(h.options), { identity, source: 'credential-store' });
  assert.deepEqual(h.writes, []); assert.deepEqual(h.validated, [{ token: 'saved-fixture-token', region: 'us' }]);
});

test('setup prompts for first-time or replacement credentials and saves only after validation', async () => {
  for (const stored of [null, 'saved-fixture-token']) {
    const h = setupHarness(stored); h.options.choose = async () => 'replace';
    h.options.prompt = async prompt => { assert.equal(prompt.mask, false); return '  replacement-fixture-token  '; };
    h.options.createClient = ({ token }) => ({ user: async () => { assert.deepEqual(h.writes, []); assert.equal(token, 'replacement-fixture-token'); return identity; } });
    const result = await authenticateSetup(h.options);
    assert.equal(result.source, 'credential-store'); assert.deepEqual(h.writes, ['replacement-fixture-token']);
    assert.ok(h.notices[0].includes('/us/settings/api-tokens'));
  }
});

test('invalid replacements, empty tokens, no accessible courses and cancellation preserve saved credentials', async () => {
  for (const scenario of ['invalid', 'empty', 'no-courses', 'cancel']) {
    const h = setupHarness(); h.options.choose = async () => 'replace';
    h.options.prompt = async () => {
      if (scenario === 'cancel') throw Object.assign(new Error('prompt cancelled'), { name: 'ExitPromptError' });
      return scenario === 'empty' ? '  ' : 'replacement-fixture-token';
    };
    h.options.createClient = () => ({ user: async () => {
      if (scenario === 'invalid') throw new EdError('Invalid token', 401);
      return { ...identity, courses: [] };
    } });
    await assert.rejects(authenticateSetup(h.options));
    assert.deepEqual(h.writes, []); assert.equal(h.saved(), 'saved-fixture-token');
  }
});

test('a rejected saved token offers replacement, while transient failures never request replacement', async () => {
  const h = setupHarness(); h.options.choose = async () => 'reuse';
  h.options.replaceInvalid = async prompt => { assert.equal(prompt.default, true); return true; };
  h.options.prompt = async () => 'valid-replacement';
  h.options.createClient = ({ token }) => ({ user: async () => {
    if (token === 'saved-fixture-token') throw new EdError('Rejected', 401); return identity;
  } });
  await authenticateSetup(h.options); assert.deepEqual(h.writes, ['valid-replacement']);
  const declined = setupHarness(); declined.options.choose = async () => 'reuse';
  declined.options.createClient = () => ({ user: async () => { throw new EdError('Rejected', 401); } });
  declined.options.replaceInvalid = async () => false;
  await assert.rejects(authenticateSetup(declined.options), /Cancelled/); assert.deepEqual(declined.writes, []);
  for (const status of [0, 429, 503]) {
    const failed = setupHarness(); failed.options.choose = async () => 'reuse';
    failed.options.createClient = () => ({ user: async () => { throw new EdError('Temporary failure', status); } });
    await assert.rejects(authenticateSetup(failed.options), /Temporary failure/); assert.deepEqual(failed.writes, []);
  }
});

test('environment credentials retain precedence without store access or prompts, including a rejected environment token', async () => {
  const h = setupHarness('saved-fixture-token', { EDSTEM_TOKEN: 'env-fixture-token' });
  assert.equal((await authenticateSetup(h.options)).source, 'environment');
  assert.deepEqual(h.reads, []); assert.deepEqual(h.writes, []);
  assert.equal(h.validated[0].token, 'env-fixture-token'); assert.match(h.notices[0], /Using EDSTEM_TOKEN/);
  h.options.createClient = () => ({ user: async () => { throw new EdError('Rejected', 401); } });
  await assert.rejects(authenticateSetup(h.options), /Rejected/); assert.deepEqual(h.writes, []);
});

test('setup credential lookup respects the selected region and data directory', async () => {
  const saved = new Map([['root-one:us', 'us-fixture-token']]); const lookups = [];
  const entryFactory = async (root, region) => {
    const key = `${root}:${region}`; lookups.push(key);
    return { getPassword: async () => saved.get(key), setPassword: async token => saved.set(key, token) };
  };
  for (const [root, region] of [['root-one', 'us'], ['root-one', 'au'], ['root-two', 'us']]) {
    const credentials = new Credentials(root, region, { env: {}, entryFactory });
    await authenticateSetup({ root, region, credentials, choose: async () => 'reuse',
      prompt: async () => `${root}-${region}-new-token`, createClient: options => ({ user: async () => {
        assert.equal(options.region, region); return identity;
      } }) });
  }
  assert.deepEqual([...new Set(lookups)], ['root-one:us', 'root-one:au', 'root-two:us']);
  assert.equal(saved.get('root-one:us'), 'us-fixture-token'); assert.equal(saved.size, 3);
});

test('agent add persists selection, rejects invalid selectors without changes, and supports targeted sync/resume', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ed-recall-add-')); t.after(() => rm(root, { recursive: true, force: true }));
  const second = { ...course, id: '43', code: 'CS43' }, ambiguous = { ...course, id: '44' };
  const courses = [course, second, ambiguous];
  const config = await loadConfig(root);
  await bindAccount(root, config, 'us', { userId: '9', courses }, account => { account.selectedCourses = ['44']; });
  await bindAccount(root, config, 'us', { ...identity, courses }, account => { account.selectedCourses = ['42']; });
  const dir = accountDir(root, config), now = new Date().toISOString();
  const oldThread = await new EdClient({ token: 'fixture-token', interval: 0, sleep: async () => {}, fetchImpl: async () => Response.json(threadResponse()) }).thread('100');
  const { archive } = await writeThread(dir, oldThread, course);
  await writeFile(join(dir, 'sync.json'), JSON.stringify({ version: 1, courses: { 42: { complete: true, startedAt: now, lastSuccessAt: now, completed: [] } } }));
  const oldArchive = await readFile(archive.path);
  const rawUser = { ...userResponse, courses: courses.map(c => ({ course: { ...c, id: Number(c.id) } })) };
  const run = (args, broken = false) => {
    const raw = threadResponse(101); raw.thread.course_id = 43;
    if (broken) raw.thread.comments = { items: [], has_more: true };
    const source = `
      import { main } from ${JSON.stringify(new URL('../src/agent-cli.mjs', import.meta.url).href)};
      import { EdClient } from ${JSON.stringify(new URL('../src/core/api.mjs', import.meta.url).href)};
      const get = EdClient.prototype.get;
      EdClient.prototype.get = function(path) { this.sleep = async () => {}; return get.call(this, path); };
      const paths = []; globalThis.fetch = async url => {
        paths.push(url.pathname);
        if (url.pathname === '/api/user') return Response.json(${JSON.stringify(rawUser)});
        if (url.pathname === '/api/courses/43/threads') return Response.json({ threads: url.searchParams.get('offset') === '0' ? [{ id: 101 }] : [] });
        if (url.pathname === '/api/threads/101') return Response.json(${JSON.stringify(raw)});
        throw new Error('Unexpected request');
      };
      await main(['node', 'ed-recall', '--data-dir', ${JSON.stringify(root)}, ...${JSON.stringify(args)}]);
      process.stderr.write('\\nTEST_REQUESTS:' + JSON.stringify(paths));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', env: { ...process.env, EDSTEM_TOKEN: 'fixture-token' } });
    return { ...result, data: JSON.parse(result.stdout), paths: JSON.parse(result.stderr.split('TEST_REQUESTS:')[1]) };
  };
  const before = await readFile(join(root, 'config.json'));
  for (const selector of ['999', 'CS101']) {
    const result = run(['agent', 'add', selector]); assert.equal(result.status, 1);
    assert.deepEqual(await readFile(join(root, 'config.json')), before);
  }
  let result = run(['agent', 'add']); assert.equal(result.status, 1); assert.deepEqual(result.paths, []);
  result = run(['agent', 'add', 'cs43']); assert.equal(result.status, 0);
  assert.equal(result.data.added, true); assert.deepEqual(result.data.selectedCourses, ['42', '43']);
  result = run(['agent', 'add', '43']); assert.equal(result.data.added, false); assert.deepEqual(result.data.selectedCourses, ['42', '43']);
  const listed = run(['agent', 'list']); assert.deepEqual(listed.data.courses.map(c => c.id), ['42', '43']);
  assert.equal(listed.data.courses[1].syncState, 'not-synced'); assert.deepEqual(listed.paths, []);
  result = run(['agent', 'sync', '--course', '43'], true); assert.equal(result.status, 1);
  assert.equal(result.data.failures[0].threadId, '101');
  assert.deepEqual((await loadConfig(root)).accounts['us-7'].selectedCourses, ['42', '43']);
  result = run(['agent', 'sync', '--resume', '--course', '43']); assert.equal(result.status, 0);
  assert.equal(result.data.fetched, 1); assert.ok(!result.paths.includes('/api/courses/42/threads'));
  result = run(['agent', 'sync', '--course', '43']); assert.equal(result.data.fetched, 0); assert.deepEqual(result.data.skippedCourses, ['43']);
  assert.deepEqual(await readFile(archive.path), oldArchive);
  assert.deepEqual((await loadConfig(root)).accounts['us-9'].selectedCourses, ['44']);
  // A stale config object from another online command must not drop the added course.
  const staleConfig = JSON.parse(before.toString());
  await bindAccount(root, staleConfig, 'us', { ...identity, courses });
  assert.deepEqual((await loadConfig(root)).accounts['us-7'].selectedCourses, ['42', '43']);
});
