import { mkdir, readFile, rename, writeFile, open, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
export function dataRoot(override) {
  if (override || process.env.ED_RECALL_HOME) return override || process.env.ED_RECALL_HOME;
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'ed-recall');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'ed-recall');
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'ed-recall');
}
export async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temp, path); } catch (e) { await unlink(temp).catch(() => {}); throw e; }
}
export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw new Error(`Cannot read ${path}; invalid or inaccessible JSON.`); }
}
export async function loadConfig(root) { return readJson(join(root, 'config.json'), { version: 1, region: 'us', activeAccount: null, accounts: {} }); }
export const saveConfig = (root, config) => atomicWrite(join(root, 'config.json'), JSON.stringify(config, null, 2) + '\n');
export function accountDir(root, config) {
  if (!config.activeAccount || !/^(us|au|eu)-\d+$/.test(config.activeAccount)) throw new Error('No local account. Run ed-recall setup first.');
  return join(root, 'accounts', config.activeAccount);
}
export async function bindAccount(root, config, region, identity, update = () => {}) {
  // Reload under a separate config lock so concurrent course additions or online
  // operations cannot overwrite a selection saved after their initial config read.
  return lock(root, async () => {
    const current = await loadConfig(root), key = `${region}-${identity.userId}`;
    current.region = region; current.activeAccount = key;
    const account = current.accounts[key] ??= { selectedCourses: [] };
    account.courses = identity.courses;
    await update(account);
    await saveConfig(root, current);
    Object.assign(config, current);
    return account;
  });
}
export async function lock(dir, task) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'writer.lock'); let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // Serialize stale-lock recovery: two recoverers must not unlink each other's new lock.
    const recoveryPath = join(dir, 'writer-recovery.lock'); let recovery;
    try { recovery = await open(recoveryPath, 'wx', 0o600); }
    catch { throw new Error(`Another recovery holds ${recoveryPath}. If no ed-recall process is running, remove this lock file and retry.`); }
    try {
      const pid = Number(await readFile(path, 'utf8'));
      let alive = true;
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); } catch (failure) { if (failure.code === 'ESRCH') alive = false; }
      }
      if (alive) throw new Error(`Another writer holds ${path}. If no ed-recall process is running, remove this lock file and retry.`);
      await unlink(path);
      try { handle = await open(path, 'wx', 0o600); } catch { throw new Error('Another process acquired the archive lock; retry later.'); }
    } finally { await recovery.close(); await unlink(recoveryPath); }
  }
  try { await handle.writeFile(String(process.pid)); return await task(); }
  finally { await handle.close(); await unlink(path); }
}
