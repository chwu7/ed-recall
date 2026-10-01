// All Ed-specific wire assumptions live here. See docs/API.md for provenance.
export class EdError extends Error {
  constructor(message, status = 0, { retryable = false } = {}) { super(message); this.name = 'EdError'; this.status = status; this.retryable = retryable; }
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export const regions = ['us', 'au', 'eu'];
export function validRegion(region) {
  if (!regions.includes(region)) throw new EdError('Region must be us, au, or eu.');
  return region;
}
export function id(value) {
  if (!/^\d+$/.test(String(value))) throw new EdError('Unexpected Ed identifier.');
  return String(value);
}
export class EdClient {
  #token;
  constructor({ token, region = 'us', fetchImpl = globalThis.fetch, sleep = pause, interval = 500 }) {
    this.#token = token;
    this.region = validRegion(region);
    this.base = `https://${region}.edstem.org/api/`;
    this.fetch = fetchImpl; this.sleep = sleep; this.interval = interval;
  }
  async get(path) {
    const url = new URL(path, this.base);
    if (url.origin !== new URL(this.base).origin || !url.pathname.startsWith('/api/') || url.username || url.password) {
      throw new EdError('Refusing an API continuation outside the selected Ed API host.');
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      await this.sleep(this.interval);
      let response;
      try {
        response = await this.fetch(url, { headers: { Authorization: `Bearer ${this.#token}`, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(30000) });
      } catch {
        if (attempt === 4) throw new EdError('Ed request failed after retries (network, timeout, or redirect).', 0, { retryable: true });
        await this.sleep(1000 * 2 ** attempt); continue;
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt === 4) throw new EdError(`Ed returned HTTP ${response.status}; retry sync later.`, response.status, { retryable: response.status >= 500 });
        const header = response.headers.get('retry-after');
        const seconds = header && /^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
        if (seconds > 300000) throw new EdError('Ed requests a long rate-limit pause; retry sync later.', 429);
        await this.sleep(Math.max(Number.isFinite(seconds) ? seconds : 0, 1000 * 2 ** attempt) + Math.random() * 250);
        continue;
      }
      if (!response.ok) throw new EdError(`Ed returned HTTP ${response.status}${response.status === 401 ? '; check your token and region' : response.status === 403 ? '; access denied' : ''}.`, response.status);
      try {
        const scrub = value => typeof value === 'string' ? (this.#token ? value.split(this.#token).join('[REDACTED]') : value)
          : Array.isArray(value) ? value.map(scrub) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)])) : value;
        return scrub(await response.json());
      } catch { throw new EdError('Ed returned invalid or excessively nested JSON.'); }
    }
  }
  async user() {
    const data = await this.get('user');
    if (!data?.user?.id || !Array.isArray(data.courses)) throw new EdError('Unexpected /user response shape.');
    return { userId: id(data.user.id), courses: data.courses.map(item => {
      const c = item.course;
      if (!c || typeof c.code !== 'string' || typeof c.name !== 'string') throw new EdError('Unexpected course response shape.');
      return { id: id(c.id), code: c.code, name: c.name, year: c.year ?? '', session: c.session ?? '', status: c.status ?? 'unknown' };
    }) };
  }
  async *threads(courseId) {
    const seen = new Set();
    let offset = 0;
    // Request one extra empty page instead of assuming a short page ends the list.
    for (let page = 0; page < 100000; page++) {
      const data = await this.get(`courses/${id(courseId)}/threads?limit=100&offset=${offset}&sort=new`);
      if (!Array.isArray(data?.threads)) throw new EdError('Unexpected thread-list response shape.');
      if (!data.threads.length) return;
      let added = 0;
      for (const thread of data.threads) {
        const key = id(thread.id);
        if (!seen.has(key)) { seen.add(key); added++; yield key; }
      }
      if (!added) throw new EdError('Thread pagination stopped making progress; sync is incomplete.');
      offset += data.threads.length;
    }
    throw new EdError('Thread pagination exceeded the safety limit.');
  }
  async thread(threadId) {
    const data = await this.get(`threads/${id(threadId)}`);
    if (!data?.thread || id(data.thread.id) !== id(threadId)) throw new EdError('Unexpected thread-detail response shape.');
    if (data.has_more || data.next) throw new EdError('Unsupported thread-detail continuation; thread not archived.');
    const users = new Map((data.users ?? []).map(u => [String(u.id), u]));
    const seen = new Set(); let deletedReplies = 0;
    const collect = async (value, label) => {
      // Arrays are the observed shape. Explicit items/next envelopes are a defensive extension,
      // covered by synthetic fixtures, not claimed as a verified Ed contract.
      if (Array.isArray(value)) return value;
      if (!value || !Array.isArray(value.items)) throw new EdError(`Missing or unsupported ${label} collection.`);
      const all = [...value.items]; let next = value.next; const pages = new Set();
      if (value.has_more && !next) throw new EdError(`Truncated ${label}: no supported continuation.`);
      while (next) {
        if (typeof next !== 'string' || pages.has(next) || pages.size > 10000) throw new EdError(`Invalid ${label} pagination.`);
        pages.add(next);
        const page = await this.get(next);
        if (!Array.isArray(page?.items)) throw new EdError(`Unexpected ${label} page.`);
        all.push(...page.items); next = page.next;
        if (page.has_more && !next) throw new EdError(`Truncated ${label} page.`);
      }
      if (value.total != null && all.length !== value.total) throw new EdError(`Incomplete ${label} collection.`);
      return all;
    };
    const walk = async (node, parentId, kind) => {
      const nodeId = id(node.id);
      const identity = `${kind === 'post' ? 'post' : 'reply'}:${nodeId}`;
      if (seen.has(identity)) throw new EdError('Duplicate or cyclic reply IDs in thread.');
      seen.add(identity);
      if (kind !== 'post' && node.deleted_at) deletedReplies++;
      if (seen.size > 100000) throw new EdError('Thread exceeds reply safety limit.');
      if (typeof node.content !== 'string') throw new EdError('Missing post content.');
      if (node.has_more || node.comments_next || node.answers_next) throw new EdError('Unsupported reply continuation; thread not archived.');
      const user = users.get(String(node.user_id));
      const result = { id: nodeId, parentId, kind, content: node.content, createdAt: node.created_at ?? null, updatedAt: node.updated_at ?? null,
        author: node.is_anonymous ? 'Anonymous' : user?.name ?? 'Unknown', role: node.is_anonymous ? null : user?.course_role ?? null,
        endorsed: Boolean(node.is_endorsed), deleted: Boolean(node.deleted_at), children: [] };
      const comments = await collect(node.comments, 'comments');
      if (kind === 'post') {
        for (const child of await collect(node.answers, 'answers')) result.children.push(await walk(child, nodeId, 'answer'));
      }
      for (const child of comments) result.children.push(await walk(child, nodeId, 'comment'));
      return result;
    };
    const thread = data.thread;
    const post = await walk(thread, null, 'post');
    if (typeof thread.title !== 'string') throw new EdError('Missing thread title.');
    const returnedReplies = seen.size - 1, visibleReplies = returnedReplies - deletedReplies;
    // Live responses can include deleted replies that reply_count excludes. The counter
    // can also disagree with the accessible tree; preserve that tree with a coverage warning.
    const warnings = thread.reply_count != null && thread.reply_count !== returnedReplies && thread.reply_count !== visibleReplies
      ? [`Ed reports ${thread.reply_count} replies but returned ${returnedReplies} (${visibleReplies} non-deleted); reply coverage is uncertain.`] : [];
    return { id: id(thread.id), courseId: id(thread.course_id), number: thread.number ?? null, title: thread.title,
      url: `https://edstem.org/${this.region}/courses/${id(thread.course_id)}/discussion/${id(thread.id)}`,
      createdAt: thread.created_at ?? null, updatedAt: thread.updated_at ?? null, warnings, post };
  }
}
