import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
for (const dir of ['src', 'bin', 'scripts']) {
  for (const name of await readdir(dir, { recursive: true })) {
    if (!name.endsWith('.mjs')) continue;
    const result = spawnSync(process.execPath, ['--check', `${dir}/${name}`], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(1);
  }
}
const skill = await readFile('skills/ed-recall/SKILL.md', 'utf8');
if (!skill.startsWith('---\nname: ed-recall\n')) throw new Error('Invalid bundled skill');
const db = new DatabaseSync(':memory:');
db.exec('CREATE VIRTUAL TABLE probe USING fts5(body)');
db.close();
console.log('Build verified: distributable JavaScript, bundled skill, SQLite FTS5.');
