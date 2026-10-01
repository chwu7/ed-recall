import { select, password, confirm } from '@inquirer/prompts';
import { Credentials, rememberSecret } from './auth.mjs';
import { EdClient } from './core/api.mjs';

export async function authenticateSetup({ root, region, credentials = new Credentials(root, region),
  choose = select, prompt = password, replaceInvalid = confirm, notify = () => {},
  createClient = options => new EdClient(options) }) {
  const existing = await credentials.get();
  let token = existing.token, source = existing.source, replacing = false;
  const enterToken = async () => {
    notify(`Create a personal API token at https://edstem.org/${region}/settings/api-tokens`);
    token = rememberSecret((await prompt({ message: 'Ed API token (hidden):', mask: false })).trim());
    if (!token) throw new Error('Token cannot be empty.');
    source = 'credential-store'; replacing = true;
  };
  if (source === 'environment') {
    notify('Using EDSTEM_TOKEN. Unset it to use or replace a saved token.');
  } else if (token) {
    const action = await choose({ message: 'A saved Ed token is available:', default: 'reuse', choices: [
      { name: 'Use saved token', value: 'reuse' }, { name: 'Enter a new token', value: 'replace' },
    ] });
    if (action === 'replace') await enterToken();
  } else await enterToken();

  let identity;
  try { identity = await createClient({ token, region }).user(); }
  catch (error) {
    if (error.status !== 401 || source !== 'credential-store' || replacing) throw error;
    if (!await replaceInvalid({ message: 'The saved token was rejected. Enter a new token?', default: true })) throw new Error('Cancelled.');
    await enterToken();
    identity = await createClient({ token, region }).user();
  }
  if (!identity.courses.length) throw new Error('Ed returned no accessible courses for this account and region.');
  if (replacing) await credentials.save(token);
  return { identity, source };
}
