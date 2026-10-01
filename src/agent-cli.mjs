import { password, checkbox, select, confirm } from '@inquirer/prompts';
import { mkdir, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { dataRoot, loadConfig, saveConfig, bindAccount, accountDir, lock } from './files.mjs';
import { Credentials, rememberSecret, redact } from './auth.mjs';
import { EdClient, validRegion } from './core/api.mjs';
import { SearchIndex } from './index-db.mjs';
import { syncCourses, syncStatus } from './sync.mjs';
import { installSkill, bundledSkill } from './skill.mjs';
import { archiveFiles } from './archive.mjs';
import { listCourses } from './course-list.mjs';

const clean = value => redact(String(value)).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const out = value => process.stdout.write(clean(value) + '\n');
const json = value => out(JSON.stringify({ schemaVersion: 1, ...value }));
const HELP = `ed-recall — local engine for the ed-recall agent skill

One-time terminal commands:
  ed-recall setup [--region us|au|eu] [--data-dir PATH]
  ed-recall skill install --target pi|codex|claude|all [--force]
  ed-recall skill path
  ed-recall logout

Recovery:
  ed-recall agent sync --resume [--course ID]
  ed-recall agent sync --refresh [--course ID]

Local course overview:
  ed-recall agent list

Use the installed skill in your agent to sync and ask questions.
The "agent" commands are a JSON interface used by that skill.
On Windows PowerShell, use ed-recall.cmd if the npm .ps1 shim is blocked.`;
const valueOptions = new Set(['--data-dir', '--region', '--course', '--limit', '--max-chars', '--target']);
function parse(argv) {
  const options = {}, words = [];
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (valueOptions.has(arg)) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error('A command option is missing its value. Run ed-recall --help.');
      if (options[arg] !== undefined) throw new Error('A command option was repeated. Run ed-recall --help.');
      options[arg] = argv[++i];
    } else if (arg === '--force' || arg === '--resume' || arg === '--refresh') options[arg] = true;
    else if (arg.startsWith('-')) throw new Error('Unknown option. Run ed-recall --help.');
    else words.push(arg);
  }
  return { options, words };
}
function positive(value, max = 100) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) throw new Error(`Value must be an integer from 1 to ${max}.`);
  return number;
}
export function resolveCourse(courses, selector) {
  const matches = courses.filter(c => c.id === String(selector) || c.code.toLowerCase() === String(selector).toLowerCase());
  if (matches.length !== 1) throw new Error(matches.length ? `Course code is ambiguous. Use an ID: ${matches.map(c => `${c.id} (${c.year} ${c.session})`).join(', ')}` : 'Course not found. Run setup and use a listed ID or exact code.');
  return matches[0];
}
function requireTerminal() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Setup needs an interactive terminal with a hidden token prompt. Open Command Prompt, PowerShell, or another normal terminal.');
}
export async function main(argv = process.argv) {
  let agentMode = argv.includes('agent');
  try {
    if (argv.slice(2).includes('--help') || argv.slice(2).includes('-h') || argv.length === 2) { out(HELP); return; }
    if (argv.slice(2).includes('--version') || argv.slice(2).includes('-V')) { out('0.2.0'); return; }
    const { options, words } = parse(argv);
    if (options['--resume'] && (words[0] !== 'agent' || words[1] !== 'sync')) throw new Error('--resume is only supported by agent sync.');
    if (options['--refresh'] && (words[0] !== 'agent' || words[1] !== 'sync')) throw new Error('--refresh is only supported by agent sync.');
    if (options['--resume'] && options['--refresh']) throw new Error('Choose either --resume or --refresh.');
    agentMode = words[0] === 'agent';
    const root = resolve(dataRoot(options['--data-dir']));
    const config = await loadConfig(root);
    const region = validRegion(options['--region'] || config.region);
    const credentials = new Credentials(root, region);
    const requireWords = (...expected) => {
      if (words.length !== expected.length || words.some((word, i) => word !== expected[i])) throw new Error('Unknown command or extra arguments. Run ed-recall --help.');
    };
    if (words[0] === 'setup') {
      requireWords('setup'); requireTerminal();
      const selectedRegion = options['--region'] || await select({ message: 'Ed region (from your Ed URL):', choices: ['us', 'au', 'eu'].map(value => ({ name: value.toUpperCase(), value })), default: region });
      let token, source;
      if (process.env.EDSTEM_TOKEN?.trim()) { token = rememberSecret(process.env.EDSTEM_TOKEN.trim()); source = 'environment'; }
      else {
        out(`Create a personal API token at https://edstem.org/${selectedRegion}/settings/api-tokens`);
        token = rememberSecret((await password({ message: 'Ed API token (hidden):', mask: false })).trim());
        if (!token) throw new Error('Token cannot be empty.');
        source = 'credential-store';
      }
      const identity = await new EdClient({ token, region: selectedRegion }).user();
      if (source === 'credential-store') await new Credentials(root, selectedRegion).save(token);
      const account = await bindAccount(root, config, selectedRegion, identity);
      if (!identity.courses.length) throw new Error('Ed returned no accessible courses for this account and region.');
      account.selectedCourses = await checkbox({ message: 'Courses to archive:', required: true,
        choices: identity.courses.map(c => ({ name: `${c.code} — ${c.name} (${c.year} ${c.session}; ${c.status}; ID ${c.id})`, value: c.id, checked: account.selectedCourses.includes(c.id) })) });
      await saveConfig(root, config);
      out(`Authentication: ${source}. Selected ${account.selectedCourses.length} course(s).`);
      if (await confirm({ message: 'Install or update the ed-recall agent skill?', default: true })) {
        const targets = await checkbox({ message: 'Install for:', required: true, choices: ['pi', 'codex', 'claude'].map(value => ({ name: value, value })) });
        for (const target of targets) out((await installSkill(target)).path);
      }
      out('Setup complete. Open your agent and invoke the ed-recall skill to sync.');
      return;
    }
    if (words[0] === 'logout') {
      requireWords('logout');
      const removed = await credentials.logout();
      out(removed ? 'Saved token removed. Local archives remain.' : 'No saved token found. Local archives remain.');
      if (process.env.EDSTEM_TOKEN) out('EDSTEM_TOKEN is still set in this shell; unset it separately.');
      return;
    }
    if (words[0] === 'skill') {
      if (words[1] === 'path') { requireWords('skill', 'path'); out(bundledSkill); return; }
      requireWords('skill', 'install');
      let target = options['--target'];
      if (!target) { requireTerminal(); target = await select({ message: 'Install for:', choices: ['pi', 'codex', 'claude', 'all'].map(value => ({ name: value, value })) }); }
      if (!['pi', 'codex', 'claude', 'all'].includes(target)) throw new Error('Target must be pi, codex, claude, or all.');
      for (const agent of target === 'all' ? ['pi', 'codex', 'claude'] : [target]) {
        const installed = await installSkill(agent, { force: options['--force'] });
        out(`${installed.changed ? 'Installed' : 'Already installed'}: ${installed.path}`);
      }
      return;
    }
    if (words[0] !== 'agent') throw new Error('Unknown command. Run ed-recall --help.');
    const command = words[1];
    if (!['status', 'list', 'courses', 'sync', 'search', 'context', 'read', 'reindex'].includes(command)) throw new Error('Unknown agent operation.');
    const online = async () => {
      const credential = await credentials.get();
      if (!credential.token) throw new Error('No token available. Run ed-recall setup in a terminal or supply EDSTEM_TOKEN.');
      const client = new EdClient({ token: credential.token, region });
      const identity = await client.user();
      const account = await bindAccount(root, config, region, identity);
      return { client, identity, account, dir: accountDir(root, config) };
    };
    const local = () => {
      if (options['--region'] && config.activeAccount && !config.activeAccount.startsWith(`${region}-`)) throw new Error('The requested region differs from the active archive. Run setup for that region first.');
      return { account: config.accounts[config.activeAccount], dir: accountDir(root, config) };
    };
    const withIndex = async task => {
      const { account, dir } = local();
      await mkdir(dir, { recursive: true, mode: 0o700 });
      return lock(dir, async () => {
        const index = new SearchIndex(dir);
        try { await index.reconcile(dir); return await task(index, { account, dir }); }
        finally { index.close(); }
      });
    };
    if (command === 'status' || command === 'list') {
      requireWords('agent', command);
      if (!config.activeAccount) { json({ configured: false, needsSync: true, dataDirectory: root, courses: [] }); return; }
      const { account, dir } = local();
      if (command === 'list') {
        json({ configured: true, account: config.activeAccount, dataDirectory: root, archiveDirectory: join(dir, 'archive'),
          ...await listCourses(dir, account.selectedCourses, account.courses) });
        return;
      }
      const files = await archiveFiles(dir);
      json({ configured: true, account: config.activeAccount, dataDirectory: root, archiveDirectory: join(dir, 'archive'), archivedThreads: files.length,
        ...await syncStatus(dir, account.selectedCourses) });
      return;
    }
    if (command === 'courses') {
      requireWords('agent', 'courses');
      const { identity, account } = await online();
      json({ courses: identity.courses.map(c => ({ ...c, selected: account.selectedCourses.includes(c.id) })) }); return;
    }
    if (command === 'sync') {
      requireWords('agent', 'sync');
      const { client, identity, account, dir } = await online();
      const tracked = account.selectedCourses.length ? account.selectedCourses : (await syncStatus(dir, [])).courses.map(c => c.id);
      const courses = options['--course'] ? [resolveCourse(identity.courses, options['--course'])] : tracked.map(key => resolveCourse(identity.courses, key));
      if (!courses.length) throw new Error('No selected courses. Run setup in a terminal, or specify --course <id-or-code>.');
      const result = await lock(dir, async () => {
        const index = new SearchIndex(dir);
        try {
          await index.reconcile(dir);
          return await syncCourses({ client, dir, courses, index, resumeOnly: Boolean(options['--resume']), refresh: Boolean(options['--refresh']),
            onProgress: message => process.stderr.write(clean(message) + '\n') });
        } finally { index.close(); }
      });
      json({ ...result, status: await syncStatus(dir, courses.map(c => c.id)) }); if (result.failures.length) process.exitCode = 1;
      return;
    }
    if (command === 'search' || command === 'context') {
      if (words.length !== 3) throw new Error('The agent operation needs one quoted query.');
      const query = words[2];
      await withIndex(async (index, { account, dir }) => {
        const settings = { limit: options['--limit'] ? positive(options['--limit']) : 10,
          courseId: options['--course'] ? resolveCourse(account.courses, options['--course']).id : undefined };
        const freshness = await syncStatus(dir, settings.courseId ? [settings.courseId] : []);
        const result = command === 'search' ? { query, results: index.search(query, settings) }
          : index.context(query, { ...settings, maxChars: options['--max-chars'] ? positive(options['--max-chars'], 1000000) : 16000 });
        json({ ...result, freshness });
      });
      return;
    }
    if (command === 'read') {
      if (words.length !== 3) throw new Error('The agent read operation needs one thread ID.');
      await withIndex(async index => json({ thread: index.thread(words[2]) })); return;
    }
    requireWords('agent', 'reindex');
    const { dir } = local();
    await lock(dir, async () => {
      for (const suffix of ['', '-wal', '-shm']) await unlink(join(dir, `index.sqlite${suffix}`)).catch(e => { if (e.code !== 'ENOENT') throw e; });
      const index = new SearchIndex(dir);
      try { json({ indexedThreads: await index.reconcile(dir) }); } finally { index.close(); }
    });
  } catch (error) {
    const message = error.name === 'ExitPromptError' ? 'Cancelled.' : error.message;
    if (agentMode) json({ error: { message: clean(message) } });
    else process.stderr.write(`ed-recall: ${clean(message)}\n`);
    process.exitCode = 1;
  }
}
