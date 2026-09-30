import { readFile, mkdir, copyFile, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { atomicWrite } from './files.mjs';
import { createHash } from 'node:crypto';
export const bundledSkill = fileURLToPath(new URL('../skills/ed-recall/SKILL.md', import.meta.url));
export const skillTargets = (home = homedir()) => ({
  pi: join(home, '.pi', 'agent', 'skills', 'ed-recall'),
  codex: join(home, '.agents', 'skills', 'ed-recall'),
  claude: join(home, '.claude', 'skills', 'ed-recall'),
});
export async function installSkill(target, { force = false, home } = {}) {
  const targets = skillTargets(home);
  if (!(target in targets)) throw new Error('Skill target must be pi, codex, or claude.');
  const directory = targets[target], destination = join(directory, 'SKILL.md');
  const content = await readFile(bundledSkill, 'utf8');
  let legacy;
  if (target === 'codex') {
    legacy = join(home ?? homedir(), '.codex', 'skills', 'ed-recall', 'SKILL.md');
    let old;
    try { old = await readFile(legacy, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (old != null) {
      const hash = createHash('sha256').update(old.replace(/\r\n/g, '\n')).digest('hex');
      if (hash !== '284c116f4d057f0ff2d28ea826194285bcb57945605df04c5afe35feb71d1804') {
        throw new Error(`An older Codex skill differs from the previous bundled version at ${legacy}. Review or remove that copy before installing the new skill.`);
      }
    } else legacy = null;
  }
  await mkdir(directory, { recursive: true });
  let changed = false;
  try {
    await copyFile(bundledSkill, destination, constants.COPYFILE_EXCL);
    changed = true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    if (await readFile(destination, 'utf8') !== content) {
      if (!force) throw new Error(`Skill already exists at ${destination}. Review it before using --force to replace it.`);
      await atomicWrite(destination, content); changed = true;
    }
  }
  if (legacy) await unlink(legacy);
  return { target, path: destination, changed: changed || Boolean(legacy), migrated: Boolean(legacy) };
}
