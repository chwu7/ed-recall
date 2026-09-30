import { Command, Option } from 'commander';
import { password, checkbox, select, confirm } from '@inquirer/prompts';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { dataRoot, loadConfig, saveConfig, bindAccount, accountDir, lock } from './files.mjs';
import { Credentials, rememberSecret, redact } from './auth.mjs';
import { EdClient, validRegion } from './core/api.mjs';
import { SearchIndex } from './index-db.mjs';
import { syncCourses, syncStatus } from './sync.mjs';
import { installSkill, bundledSkill } from './skill.mjs';
import { archiveFiles } from './archive.mjs';

const clean = value => redact(String(value)).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const out = value => process.stdout.write(clean(value) + '\n');
const json = value => out(JSON.stringify({ schemaVersion: 1, ...value }, null, 2));
const positive = (value, max = 100) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) throw new Error(`Value must be an integer from 1 to ${max}.`);
  return number;
};
export function resolveCourse(courses, selector) {
  const matches = courses.filter(c => c.id === String(selector) || c.code.toLowerCase() === String(selector).toLowerCase());
  if (matches.length !== 1) throw new Error(matches.length ? `Course code is ambiguous. Use an ID: ${matches.map(c => `${c.id} (${c.year} ${c.session})`).join(', ')}` : 'Course not found. Run ed-recall courses and use a listed ID or exact code.');
  return matches[0];
}
function requireTerminal() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('This command needs an interactive terminal. For automation use EDSTEM_TOKEN, --region, and sync --course <id>.');
}
export async function main(argv = process.argv) {
  const program = new Command();
  program.name('ed-recall').version('0.1.0').description('Archive and search your Ed Discussion courses locally.')
    .option('--data-dir <path>', 'override user data directory (or ED_RECALL_HOME)')
    .addOption(new Option('--region <region>', 'Ed region; defaults to saved region or us').choices(['us', 'au', 'eu']))
    .showHelpAfterError(false).exitOverride()
    // Unknown options and argument values are deliberately not echoed; a user may accidentally paste a secret.
    .configureOutput({ writeErr: () => {} });
  const environment = async () => {
    const opts = program.opts(); const root = resolve(dataRoot(opts.dataDir)); const config = await loadConfig(root);
    const region = validRegion(opts.region || config.region);
    return { root, config, region, credentials: new Credentials(root, region) };
  };
  const online = async () => {
    const env = await environment(); const credential = await env.credentials.get();
    if (!credential.token) throw new Error('No token available. Run ed-recall auth login or supply EDSTEM_TOKEN.');
    const client = new EdClient({ token: credential.token, region: env.region });
    const identity = await client.user(); const account = await bindAccount(env.root, env.config, env.region, identity);
    return { ...env, ...credential, client, identity, account, dir: accountDir(env.root, env.config) };
  };
  const local = async () => {
    const env = await environment();
    if (program.opts().region && env.config.activeAccount && !env.config.activeAccount.startsWith(`${env.region}-`)) throw new Error('The requested region differs from the active archive. Run setup for that region first.');
    return { ...env, dir: accountDir(env.root, env.config), account: env.config.accounts[env.config.activeAccount] };
  };
  const login = async (env) => {
    let token, source;
    if (process.env.EDSTEM_TOKEN?.trim()) { token = rememberSecret(process.env.EDSTEM_TOKEN.trim()); source = 'environment'; }
    else {
      requireTerminal();
      out(`Create a token at https://edstem.org/${env.region}/settings/api-tokens`);
      token = rememberSecret((await password({ message: 'Ed API token (hidden):', mask: false })).trim());
      if (!token) throw new Error('Token cannot be empty.');
      source = 'credential-store';
    }
    const identity = await new EdClient({ token, region: env.region }).user();
    if (source === 'credential-store') await env.credentials.save(token);
    const account = await bindAccount(env.root, env.config, env.region, identity);
    return { identity, account, source };
  };
  program.command('setup').description('Log in, select courses, and optionally install an agent skill').action(async () => {
    requireTerminal();
    const env = await environment();
    if (!program.opts().region) env.region = await select({ message: 'Ed region (as shown in your Ed URL):', choices: ['us', 'au', 'eu'].map(value => ({ name: value.toUpperCase(), value })), default: env.region });
    env.credentials = new Credentials(env.root, env.region);
    const { identity, account, source } = await login(env);
    if (!identity.courses.length) throw new Error('Ed returned no accessible courses for this account and region.');
    account.selectedCourses = await checkbox({ message: 'Courses to archive:', required: true,
      choices: identity.courses.map(c => ({ name: `${c.code} — ${c.name} (${c.year} ${c.session}; ${c.status}; ID ${c.id})`, value: c.id, checked: account.selectedCourses.includes(c.id) })) });
    await saveConfig(env.root, env.config);
    out(`Authentication: ${source}. Selected ${account.selectedCourses.length} course(s).`);
    if (await confirm({ message: 'Install the ed-recall agent skill?', default: false })) {
      const targets = await checkbox({ message: 'Install for:', required: true, choices: ['pi', 'codex', 'claude'].map(value => ({ name: value, value })) });
      for (const target of targets) out((await installSkill(target)).path);
    }
    out('Setup complete. Run ed-recall sync next.');
  });
  const auth = program.command('auth').description('Manage the Ed API token');
  auth.command('login').description('Validate and save a token through a hidden prompt').action(async () => {
    const env = await environment(); const result = await login(env);
    out(`Authenticated account ${env.region}-${result.identity.userId} using ${result.source}. Run setup to choose courses, or sync --course <id>.`);
  });
  auth.command('status').description('Check token availability and validate it with Ed').option('--json', 'structured output').option('--offline', 'only check local credential availability').action(async options => {
    const env = await environment(); const { token, source } = await env.credentials.get();
    const result = { region: env.region, source, available: Boolean(token), verified: false };
    if (token && !options.offline) { const identity = await new EdClient({ token, region: env.region }).user(); result.accountId = `${env.region}-${identity.userId}`; result.verified = true; }
    if (options.json) json(result); else out(`Token source: ${source}. ${result.verified ? 'Ed authentication succeeded.' : options.offline ? 'Not checked with Ed.' : 'Run ed-recall auth login.'}`);
    if (!token) process.exitCode = 1;
  });
  auth.command('logout').description('Remove the saved token for this data directory and region').action(async () => {
    const env = await environment(); const removed = await env.credentials.logout();
    out(removed ? 'Saved token removed. Local archives remain.' : 'No saved token found. Local archives remain.');
    if (process.env.EDSTEM_TOKEN) out('EDSTEM_TOKEN is still set in the parent shell; unset it separately. Revoke the token in Ed settings if needed.');
  });
  program.command('courses').description('List accessible courses, including archived courses').option('--json', 'structured output').action(async options => {
    const env = await online(); const courses = env.identity.courses.map(c => ({ ...c, selected: env.account.selectedCourses.includes(c.id) }));
    if (options.json) json({ courses });
    else for (const c of courses) out(`${c.selected ? '*' : ' '} ${c.id}\t${c.code}\t${c.year} ${c.session}\t${c.status}\t${c.name}`);
  });
  program.command('sync').description('Fetch selected courses; resume an unfinished run automatically').option('--course <id-or-code>', 'sync one course without changing the setup selection').option('--json', 'structured summary; progress goes to stderr').action(async options => {
    const env = await online();
    const tracked = env.account.selectedCourses.length ? env.account.selectedCourses : (await syncStatus(env.dir, [])).courses.map(c => c.id);
    const courses = options.course ? [resolveCourse(env.identity.courses, options.course)] : tracked.map(key => resolveCourse(env.identity.courses, key));
    if (!courses.length) throw new Error('No selected courses. Run setup, or use sync --course <id-or-code>.');
    await lock(env.dir, async () => {
      const index = new SearchIndex(env.dir);
      try {
        await index.reconcile(env.dir);
        const result = await syncCourses({ client: env.client, dir: env.dir, courses, index,
          onProgress: message => process.stderr.write(clean(message) + '\n') });
        if (options.json) json(result);
        else {
          out(`Fetched ${result.fetched}; changed ${result.changed}; resumed ${result.resumed}; failures ${result.failures.length}.`);
          for (const failure of result.failures) out(`Course ${failure.courseId}, thread ${failure.threadId ?? '?'}: ${failure.message}`);
          for (const warning of result.warnings) out(`Thread ${warning.threadId}: ${warning.warning}`);
        }
        if (result.failures.length) process.exitCode = 1;
      } finally { index.close(); }
    });
  });
  program.command('status').description('Report local archive freshness, paths, and incomplete syncs').option('--json', 'structured output').option('--max-age-hours <hours>', 'freshness threshold', '24').action(async options => {
    const env = await environment();
    if (!env.config.activeAccount) {
      const result = { configured: false, needsSync: true, dataDirectory: env.root, courses: [] };
      if (options.json) json(result); else out(`Not configured. Run ed-recall setup. Data directory: ${env.root}`);
      return;
    }
    const dir = accountDir(env.root, env.config), account = env.config.accounts[env.config.activeAccount];
    const files = await archiveFiles(dir);
    const result = { configured: true, account: env.config.activeAccount, dataDirectory: env.root, archiveDirectory: join(dir, 'archive'),
      database: join(dir, 'index.sqlite'), archivedThreads: files.length, ...await syncStatus(dir, account.selectedCourses, positive(options.maxAgeHours, 87600)) };
    if (options.json) json(result);
    else { out(`${result.archivedThreads} archived threads. ${result.needsSync ? 'Sync recommended.' : 'Selected courses are fresh.'}\nArchive: ${result.archiveDirectory}\nIndex: ${result.database}`); for (const c of result.courses) out(`Course ${c.id}: ${c.incomplete ? 'incomplete' : 'complete'}; last successful sync ${c.lastSuccessAt ?? 'never'}${c.error ? `; ${c.error}` : ''}`); }
  });
  const withIndex = async task => {
    const env = await local(); await mkdir(env.dir, { recursive: true, mode: 0o700 });
    return lock(env.dir, async () => {
      const index = new SearchIndex(env.dir);
      try { await index.reconcile(env.dir); return await task(index, env); } finally { index.close(); }
    });
  };
  for (const name of ['search', 'context']) {
    const command = program.command(`${name} <query>`).description(name === 'search' ? 'Search archived passages with SQLite FTS5' : 'Retrieve evidence and surrounding context for a question')
      .option('--json', 'structured output').option('--course <id-or-code>', 'filter by course').option('--limit <count>', 'maximum matching passages (two per thread)', '10');
    if (name === 'context') command.option('--max-chars <count>', 'maximum retrieved text characters', '16000');
    command.action(async (query, options) => withIndex(async (index, env) => {
      const settings = { limit: positive(options.limit), courseId: options.course ? resolveCourse(env.account.courses, options.course).id : undefined };
      const freshness = await syncStatus(env.dir, settings.courseId ? [settings.courseId] : []);
      const result = name === 'search' ? { query, results: index.search(query, settings) } : index.context(query, { ...settings, maxChars: positive(options.maxChars, 1000000) });
      if (options.json) json({ ...result, freshness });
      else {
        if (freshness.needsSync) out('Archive may be incomplete or stale. Run ed-recall sync.');
        const passages = result.results ?? result.passages;
        if (!passages.length) out('No matching evidence found. Try fewer keywords or sync the course.');
        for (const p of passages) out(`${p.course.code} #${p.threadNumber ?? '?'} — ${p.title}\n${p.url}\n${p.passageId}${p.role ? ` [${p.role}]` : ''}\n${p.snippet ?? p.text}${p.truncated ? '\n[Truncated; use ed-recall read for the full thread.]' : ''}\n`);
      }
    }));
  }
  program.command('read <thread-id>').description('Read a complete local thread by its global Ed ID').option('--json', 'structured passages and metadata').action(async (key, options) => withIndex(async index => {
    const thread = index.thread(key);
    if (options.json) json({ thread }); else out(await readFile(thread.path, 'utf8'));
  }));
  program.command('reindex').description('Rebuild SQLite solely from local Markdown; no token needed').action(async () => {
    const env = await local();
    await lock(env.dir, async () => {
      for (const suffix of ['', '-wal', '-shm']) await unlink(join(env.dir, `index.sqlite${suffix}`)).catch(e => { if (e.code !== 'ENOENT') throw e; });
      const index = new SearchIndex(env.dir);
      try { out(`Indexed ${await index.reconcile(env.dir)} threads from Markdown.`); } finally { index.close(); }
    });
  });
  const skill = program.command('skill').description('Use the optional portable agent skill');
  skill.command('path').description('Print the bundled SKILL.md path for manual copying').action(() => out(bundledSkill));
  skill.command('install').description('Install for Pi, Codex, or Claude Code (user scope)')
    .addOption(new Option('--target <agent>', 'installation target').choices(['pi', 'codex', 'claude', 'all']))
    .option('--force', 'replace an existing, different ed-recall skill').action(async options => {
      let target = options.target;
      if (!target) { requireTerminal(); target = await select({ message: 'Install for:', choices: ['pi', 'codex', 'claude', 'all'].map(value => ({ name: value, value })) }); }
      for (const agent of target === 'all' ? ['pi', 'codex', 'claude'] : [target]) { const result = await installSkill(agent, options); out(`${result.changed ? 'Installed' : 'Already installed'}: ${result.path}`); }
    });
  try { await program.parseAsync(argv); }
  catch (error) {
    if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') return;
    const message = error.code?.startsWith('commander.') ? 'Invalid command or arguments. Run ed-recall --help (or <command> --help).' : error.name === 'ExitPromptError' ? 'Cancelled.' : error.message;
    if (argv.includes('--json')) json({ error: { message: clean(message) } }); else process.stderr.write(`ed-recall: ${clean(message)}\n`);
    process.exitCode = 1;
  }
}
