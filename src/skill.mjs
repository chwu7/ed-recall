import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { atomicWrite } from './files.mjs';
export const bundledSkill = fileURLToPath(new URL('../skills/ed-recall/SKILL.md', import.meta.url));
export const skillTargets = (home = homedir()) => ({
  pi: join(home, '.pi', 'agent', 'skills', 'ed-recall'),
  codex: join(home, '.codex', 'skills', 'ed-recall'),
  claude: join(home, '.claude', 'skills', 'ed-recall'),
});
export async function installSkill(target, { force = false, home } = {}) {
  const targets = skillTargets(home);
  if (!(target in targets)) throw new Error('Skill target must be pi, codex, or claude.');
  const directory = targets[target], destination = join(directory, 'SKILL.md');
  const content = await readFile(bundledSkill, 'utf8');
  await mkdir(directory, { recursive: true });
  try {
    await copyFile(bundledSkill, destination, constants.COPYFILE_EXCL);
    return { target, path: destination, changed: true };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    if (await readFile(destination, 'utf8') === content) return { target, path: destination, changed: false };
    if (!force) throw new Error(`Skill already exists at ${destination}. Review it before using --force to replace it.`);
    await atomicWrite(destination, content);
    return { target, path: destination, changed: true };
  }
}
