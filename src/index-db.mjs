import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { archiveFiles, parseArchive } from './archive.mjs';
export class SearchIndex {
  constructor(dir) {
    this.db = new DatabaseSync(join(dir, 'index.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, course_id TEXT, hash TEXT, metadata TEXT);
      CREATE TABLE IF NOT EXISTS nodes (thread_id TEXT, id TEXT, metadata TEXT, body TEXT, PRIMARY KEY(thread_id,id));
      CREATE VIRTUAL TABLE IF NOT EXISTS passages USING fts5(title, body, thread_id UNINDEXED, node_id UNINDEXED, chunk UNINDEXED, tokenize='unicode61');`);
  }
  close() { this.db.close(); }
  update(archive) {
    if (this.db.prepare('SELECT hash FROM threads WHERE id=?').get(archive.id)?.hash === archive.hash) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM passages WHERE thread_id=?').run(archive.id);
      this.db.prepare('DELETE FROM nodes WHERE thread_id=?').run(archive.id);
      const { nodes, ...metadata } = archive;
      this.db.prepare('INSERT OR REPLACE INTO threads VALUES(?,?,?,?)').run(archive.id, archive.courseId, archive.hash, JSON.stringify(metadata));
      for (const node of nodes) {
        const { text, ...info } = node;
        this.db.prepare('INSERT INTO nodes VALUES(?,?,?,?)').run(archive.id, node.id, JSON.stringify(info), text);
        // Chunk by paragraphs where possible; retain all text even for a long code block.
        const chunks = []; let chunk = '';
        for (const paragraph of text.split(/\n\s*\n/)) {
          if (chunk && chunk.length + paragraph.length > 2400) { chunks.push(chunk); chunk = ''; }
          for (let start = 0; start < paragraph.length; start += 2400) {
            const part = paragraph.slice(start, start + 2400);
            if (chunk) chunk += '\n\n'; chunk += part;
            if (chunk.length >= 2400) { chunks.push(chunk); chunk = ''; }
          }
        }
        if (chunk) chunks.push(chunk);
        chunks.forEach((body, i) => this.db.prepare('INSERT INTO passages(title,body,thread_id,node_id,chunk) VALUES(?,?,?,?,?)').run(archive.title, body, archive.id, node.id, i));
      }
      this.db.exec('COMMIT'); return true;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  async reconcile(dir) {
    const ids = new Set();
    for (const path of await archiveFiles(dir)) {
      const archive = parseArchive(await readFile(path, 'utf8'), path);
      ids.add(archive.id); this.update(archive);
    }
    for (const row of this.db.prepare('SELECT id FROM threads').all()) {
      if (ids.has(row.id)) continue;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare('DELETE FROM passages WHERE thread_id=?').run(row.id);
        this.db.prepare('DELETE FROM nodes WHERE thread_id=?').run(row.id);
        this.db.prepare('DELETE FROM threads WHERE id=?').run(row.id);
        this.db.exec('COMMIT');
      } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    }
    return ids.size;
  }
  search(query, { limit = 10, courseId } = {}) {
    const terms = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter(t => !stopWords.has(t)))].slice(0, 32);
    if (!terms.length) return [];
    const expression = terms.map(t => `"${t}"`).join(' OR ');
    const rows = this.db.prepare(`SELECT p.thread_id,p.node_id,p.chunk,p.body,bm25(passages,4,1) AS rank,
      snippet(passages,1,'[',']',' … ',40) AS snippet,t.metadata AS thread,n.metadata AS node
      FROM passages p JOIN threads t ON t.id=p.thread_id JOIN nodes n ON n.thread_id=p.thread_id AND n.id=p.node_id
      WHERE passages MATCH ? ${courseId ? 'AND t.course_id=?' : ''} ORDER BY rank,p.thread_id,p.node_id,p.chunk LIMIT 300`)
      .all(...(courseId ? [expression, courseId] : [expression]));
    const counts = new Map(), seen = new Set(), results = [];
    for (const row of rows) {
      const signature = `${row.thread_id}:${row.node_id}`;
      if (seen.has(signature) || (counts.get(row.thread_id) ?? 0) >= 2) continue;
      seen.add(signature); counts.set(row.thread_id, (counts.get(row.thread_id) ?? 0) + 1);
      const thread = JSON.parse(row.thread), node = JSON.parse(row.node);
      results.push({ threadId: thread.id, threadNumber: thread.number, course: thread.course, title: thread.title, url: thread.url,
        passageId: node.id, chunk: Number(row.chunk), parentId: node.parentId, author: node.author, role: node.role, createdAt: node.createdAt, updatedAt: node.updatedAt,
        rank: row.rank, snippet: row.snippet, text: row.body, archivePath: thread.path, line: node.line });
      if (results.length >= limit) break;
    }
    return results;
  }
  thread(threadId) {
    const row = this.db.prepare('SELECT metadata FROM threads WHERE id=?').get(String(threadId));
    if (!row) throw new Error('Thread is not in the local archive. Sync its course first.');
    return { ...JSON.parse(row.metadata), passages: this.db.prepare('SELECT metadata,body FROM nodes WHERE thread_id=? ORDER BY rowid').all(String(threadId)).map(n => ({ ...JSON.parse(n.metadata), text: n.body })) };
  }
  context(question, { maxChars = 16000, ...options } = {}) {
    const matches = this.search(question, options); const passages = [], seen = new Set(); let used = 0;
    const add = (thread, node, reason) => {
      const key = `${thread.id}:${node.id}`;
      if (seen.has(key) || used >= maxChars) return;
      seen.add(key);
      const text = node.text.slice(0, maxChars - used); used += text.length;
      passages.push({ threadId: thread.id, threadNumber: thread.number, title: thread.title, course: thread.course, url: thread.url,
        passageId: node.id, parentId: node.parentId, role: node.role, author: node.author, reason, text, truncated: text.length < (node.fullLength ?? node.text.length),
        archivePath: thread.path, line: node.line });
    };
    // Allocate evidence before surrounding material, so large posts cannot bury matches.
    for (const match of matches) {
      const thread = this.thread(match.threadId);
      const node = thread.passages.find(n => n.id === match.passageId);
      add(thread, { ...node, text: match.text, fullLength: node.text.length }, 'match');
    }
    for (const match of matches) {
      const thread = this.thread(match.threadId);
      const node = thread.passages.find(n => n.id === match.passageId);
      if (node.parentId) add(thread, thread.passages.find(n => n.id === node.parentId), 'parent');
      add(thread, thread.passages[0], 'original-post');
    }
    return { question, passages, characters: used, maxChars, limited: used >= maxChars, evidenceFound: passages.length > 0 };
  }
}
const stopWords = new Set('a an and are as at be by did do does for from how i in is it me of on or say said staff that the their them there they this to using was were what when where which who why with about ed recall cite threads'.split(' '));
