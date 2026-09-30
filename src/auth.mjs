import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const secrets = new Set();
export function rememberSecret(token) { if (token) secrets.add(token); return token; }
export function redact(text) {
  let result = String(text);
  for (const secret of secrets) result = result.split(secret).join('[REDACTED]');
  return result;
}
export async function nativeEntry(root, region) {
  try {
    const { AsyncEntry } = await import('@napi-rs/keyring');
    // Separate custom data directories and regions without putting a token in an identifier.
    const scope = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 16);
    return new AsyncEntry('ed-recall', `${scope}:${region}`, { linux: { store: 'secret-service' } });
  } catch { throw new Error('OS credential store unavailable. Use EDSTEM_TOKEN or install/unlock the platform credential store. No plaintext token file was created.'); }
}
export class Credentials {
  constructor(root, region, { env = process.env, entryFactory = nativeEntry } = {}) {
    this.root = root; this.region = region; this.env = env; this.entryFactory = entryFactory;
  }
  async get() {
    if (this.env.EDSTEM_TOKEN?.trim()) return { token: rememberSecret(this.env.EDSTEM_TOKEN.trim()), source: 'environment' };
    let token;
    try { token = await (await this.entryFactory(this.root, this.region)).getPassword(); }
    catch { throw new Error('Cannot read the OS credential store. Unlock it, install the optional keyring dependency, or supply EDSTEM_TOKEN.'); }
    return { token: rememberSecret(token), source: token ? 'credential-store' : 'none' };
  }
  async save(token) {
    rememberSecret(token);
    try { await (await this.entryFactory(this.root, this.region)).setPassword(token); }
    catch { throw new Error('Cannot save to the OS credential store. Use EDSTEM_TOKEN for automation, or enable the platform credential store and retry login. No plaintext fallback was used.'); }
  }
  async logout() {
    try { return await (await this.entryFactory(this.root, this.region)).deleteCredential(); }
    catch { throw new Error('Could not remove the saved credential. Unlock the OS credential store and retry logout.'); }
  }
}
