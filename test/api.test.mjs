import test from 'node:test';
import assert from 'node:assert/strict';
import { EdClient } from '../src/core/api.mjs';
import { threadResponse, comment, userResponse } from './fixtures/ed.mjs';
const client = fetchImpl => new EdClient({ token: 'test-secret-token', fetchImpl, interval: 0, sleep: async () => {} });
const response = value => Response.json(value);
test('user shape and courses are normalized without leaking account details', async () => {
  const data = await client(async () => response(userResponse)).user();
  assert.equal(data.userId, '7'); assert.equal(data.courses[0].id, '42'); assert.equal(data.user, undefined);
});
test('thread pagination uses actual page sizes, handles pinned duplicates, and reads through an empty page', async () => {
  const offsets = [];
  const api = client(async url => {
    const offset = Number(url.searchParams.get('offset')); offsets.push(offset);
    return response({ threads: ({ 0: [{ id: 1 }, { id: 2 }], 2: [{ id: 1 }, { id: 3 }], 4: [] })[offset] });
  });
  assert.deepEqual(await Array.fromAsync(api.threads('42')), ['1', '2', '3']);
  assert.deepEqual(offsets, [0, 2, 4]);
});
test('repeated list pages fail instead of looping or claiming completeness', async () => {
  await assert.rejects(async () => Array.fromAsync(client(async () => response({ threads: [{ id: 1 }] })).threads(42)), /progress/);
});
test('full thread includes answers, nested comments, role, source URL and separate ID namespaces', async () => {
  const raw = threadResponse(201); // A thread ID can collide with a reply ID.
  const data = await client(async () => response(raw)).thread(201);
  assert.equal(data.post.children.length, 2);
  assert.equal(data.post.children[1].children[0].content.includes('final homework'), true);
  assert.equal(data.post.children[0].role, 'staff');
  assert.equal(data.url, 'https://edstem.org/us/courses/42/discussion/201');
});
test('explicit reply continuation is followed at every nesting level (synthetic extension)', async () => {
  const raw = threadResponse(); raw.thread.reply_count = 5;
  raw.thread.answers = { items: raw.thread.answers, next: '/api/test/answer-page', total: 2 };
  raw.thread.comments[0].comments = { items: [], next: '/api/test/nested-page', total: 2 };
  const api = client(async url => response(url.pathname.endsWith('answer-page') ? { items: [comment(204, 'Second answer')], next: null }
    : url.pathname.endsWith('nested-page') ? { items: [comment(203, 'Nested one'), comment(205, 'Nested two')], next: null } : raw));
  const data = await api.thread(100);
  assert.equal(data.post.children.length, 3); assert.equal(data.post.children[2].children.length, 2);
});
test('truncated or unknown collection fails closed', async () => {
  const raw = threadResponse(); raw.thread.comments = { items: [], has_more: true };
  await assert.rejects(client(async () => response(raw)).thread(100), /Truncated/);
  raw.thread.comments = { items: [], total: 99 };
  await assert.rejects(client(async () => response(raw)).thread(100), /Incomplete/);
});

test('reply counters can exclude deleted replies; unexplained differences retain the tree with a warning', async () => {
  const raw = threadResponse();
  raw.thread.comments[0].deleted_at = '2026-09-02T00:00:00Z'; raw.thread.reply_count = 2;
  let thread = await client(async () => response(raw)).thread(100);
  assert.deepEqual(thread.warnings, []);
  assert.equal(thread.post.children[1].deleted, true);
  assert.equal(thread.post.children[1].children.length, 1);
  raw.thread.reply_count = 3;
  assert.deepEqual((await client(async () => response(raw)).thread(100)).warnings, []);
  for (const count of [1, 99]) {
    raw.thread.reply_count = count;
    thread = await client(async () => response(raw)).thread(100);
    assert.equal(thread.post.children.length, 2);
    assert.match(thread.warnings[0], /reply coverage is uncertain/);
    assert.ok(thread.warnings[0].includes(`reports ${count} replies`));
  }
});

test('exhausted network/server errors are retryable, exhausted rate limits are not', async () => {
  for (const status of [0, 503, 429]) {
    let calls = 0;
    const api = client(async () => { calls++; if (!status) throw new Error('network'); return new Response('', { status }); });
    await assert.rejects(api.user(), error => error.retryable === (status !== 429) && error.status === status);
    assert.equal(calls, 5);
  }
});
test('401 is not retried and server bodies cannot echo the token', async () => {
  let calls = 0;
  await assert.rejects(client(async () => { calls++; return new Response('test-secret-token', { status: 401 }); }).user(), e => !e.message.includes('test-secret-token') && e.status === 401);
  assert.equal(calls, 1);
});
test('rate limits honor Retry-After and retry', async () => {
  const waits = []; let calls = 0;
  const api = new EdClient({ token: 'secret', interval: 0, sleep: async ms => waits.push(ms), fetchImpl: async () => ++calls === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '2' } }) : response(userResponse) });
  assert.equal((await api.user()).userId, '7'); assert.ok(waits.some(ms => ms >= 2000));
});
test('tokens remain in headers and are scrubbed from returned fields; redirects are disabled', async () => {
  const raw = threadResponse(); raw.thread.title = 'test-secret-token';
  const api = client(async (url, options) => {
    assert.ok(!url.href.includes('test-secret-token'));
    assert.equal(options.headers.Authorization, 'Bearer test-secret-token'); assert.equal(options.redirect, 'error');
    return response(raw);
  });
  assert.equal((await api.thread(100)).title, '[REDACTED]');
  await assert.rejects(api.get('https://example.com/api/steal'), /outside/);
});
