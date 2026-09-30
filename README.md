# ed-recall

Archive the Ed Discussion threads you can access, search them locally, and give Pi, Codex, or Claude Code evidence it can cite.

`ed-recall` is a Node.js CLI. It saves one readable Markdown file per thread and indexes the original post, answers, and comments with SQLite FTS5. You can use every command without an agent. The optional skill teaches an agent how to retrieve evidence and cite the original Ed thread URLs.

**v0.1 is not published to npm.** Install from this repository or its locally generated npm tarball. Nothing in the build publishes or deploys anything. Ed's beta API has not been tested with a live account in this implementation; see [API limitations](#api-limitations) and the [manual smoke test](#manual-smoke-test-with-your-ed-account).

## Quick start

Install Node.js 24 or newer, then run this in PowerShell:

```powershell
git clone https://github.com/chwu7/ed-recall.git
cd ed-recall
npm.cmd ci
npm.cmd pack
npm.cmd install --global .\ed-recall-0.1.0.tgz
ed-recall.cmd setup
ed-recall.cmd sync
ed-recall.cmd search "late submissions"
```

On macOS or Linux, use `npm` and `ed-recall` in place of `npm.cmd` and `ed-recall.cmd`; install the generated tarball as `./ed-recall-0.1.0.tgz`. `setup` asks for your Ed region and API token in a hidden prompt, lets you choose courses, and can install the optional agent skill. Create the token through the Ed settings link it prints. Keep the token out of chat and command arguments. If you already have the repository, start at `npm ci` in its directory. The sections below explain credentials, every command, data storage, and how to check results against Ed.

## Requirements

- Node.js **24 or newer**, with npm. Check with `node --version` and `npm --version`.
- An Ed account, access to at least one Discussion course, and an Ed **personal API token** for your region.
- Internet access for installing dependencies and for authentication, course listing, and syncing. Searching, reading, status, and rebuilding the index work offline.
- For saving a token: Windows Credential Manager, macOS Keychain, or an unlocked Linux Secret Service such as GNOME Keyring. `EDSTEM_TOKEN` works when a persistent credential store is unavailable.

Windows PowerShell may block npm's `.ps1` command shims. In that case use **`npm.cmd`** and **`ed-recall.cmd`** everywhere below; no execution-policy change is necessary.

## Install from the repository

From the repository directory:

```sh
npm ci
npm pack
npm install --global ./ed-recall-0.1.0.tgz
ed-recall --help
```

`npm pack` runs the package build check and creates an npm-installable tarball in the current directory. `npm install --global` installs its executable on your npm global PATH. If your shell cannot find `ed-recall`, check `npm prefix --global`: on Windows that directory must be on PATH; on macOS/Linux its `bin` subdirectory must be on PATH. Reopen the terminal after changing PATH. Use an npm installation owned by your user rather than running setup with administrator privileges.

To use the checkout without a global installation:

```sh
node bin/ed-recall.mjs --help
node bin/ed-recall.mjs setup
node bin/ed-recall.mjs sync
```

Substitute `node bin/ed-recall.mjs` for `ed-recall` in the examples. Agents using the bundled skill expect `ed-recall` on PATH, so the global tarball installation is the simplest agent setup. To update a local installation, rebuild/pack the new checkout and install its new tarball. User data survives package upgrades and uninstalling the npm package.

## First-time setup

```sh
ed-recall setup
```

1. Choose your Ed region: `us`, `au`, or `eu`, matching the region in your normal Ed URL. The default is the saved region, or `us` on first use.
2. Create a personal API token in Ed's account settings. The CLI prints the regional link, for example <https://edstem.org/us/settings/api-tokens>. Availability can depend on your Ed account or institution.
3. Paste it into the **hidden terminal prompt**. The input is not echoed. The CLI validates the token before saving it.
4. Select courses with the checkbox prompt: Space toggles a course, arrow keys move, and Enter confirms. The list includes archived courses returned by Ed and shows IDs and terms to distinguish reused course codes.
5. Optionally choose Pi, Codex, and/or Claude Code for skill installation.
6. Run the first sync:

```sh
ed-recall sync
ed-recall status
ed-recall search "late submissions"
ed-recall context "What did staff say about late submissions?" --json
```

Rerun `setup` to change the selected courses. It validates a token again. To select a region explicitly, use `ed-recall --region eu setup`. US, AU, and EU host mappings are implemented; each requires live verification with an account in that region.

## Authentication and token storage

```sh
ed-recall auth login
ed-recall auth status
ed-recall auth status --offline --json
ed-recall auth logout
```

`auth login` prompts without echoing and validates the token. It does not select courses. `auth status` validates with Ed by default; `--offline` only checks whether a credential is available. Neither prints the token. `auth logout` deletes the saved token for the selected region and data directory, but keeps the local archive. It does not revoke the token on Ed; revoke it in Ed account settings when appropriate.

Credential precedence is **`EDSTEM_TOKEN` first**, then the OS credential store. When the environment variable is set, `login` and `setup` validate it without saving it to the credential store. An invalid environment token does not silently fall back to a saved token.

| Platform | Persistent store | If unavailable |
| --- | --- | --- |
| Windows | Windows Credential Manager through the optional `@napi-rs/keyring` native binding | Use `EDSTEM_TOKEN`; retry npm installation if the optional native package was omitted. |
| macOS | macOS Keychain through the same binding | Unlock/allow access to Keychain, or use `EDSTEM_TOKEN`. |
| Linux | Secret Service, explicitly required for persistence | Unlock/start your desktop keyring, or use `EDSTEM_TOKEN` in headless sessions. The CLI does not silently use a kernel keyring that disappears after reboot. |

There is **no plaintext token-file fallback** and no `--token` argument. Tokens are not stored in Markdown, SQLite, config, or sync state. The CLI does not read `.env` automatically, use browser passwords, or scrape session cookies. Credential entries are scoped to the data-directory path and region; keep that path consistent across runs. Changing it does not move the saved token.

For an interactive Bash session without persistent storage, enter the token without putting it in shell history:

```bash
read -rsp 'Ed API token: ' EDSTEM_TOKEN
printf '\n'
export EDSTEM_TOKEN
ed-recall --region us courses
ed-recall sync --course 12345
unset EDSTEM_TOKEN
```

For PowerShell:

```powershell
$secret = Read-Host 'Ed API token' -AsSecureString
$env:EDSTEM_TOKEN = [System.Net.NetworkCredential]::new('', $secret).Password
ed-recall.cmd --region us courses
ed-recall.cmd sync --course 12345
Remove-Item Env:EDSTEM_TOKEN
Remove-Variable secret
```

Replace `12345` with an ID returned by `courses`. For CI or scheduled jobs, inject `EDSTEM_TOKEN` through your runner's secret facility and set `ED_RECALL_HOME` to a persistent private directory. Environment variables are available to processes running with your privileges; avoid shared shells and debug dumps of the environment. `logout` cannot unset a variable in its parent shell, and will tell you when it remains set.

## Commands

Global options: `--region us|au|eu`, `--data-dir <path>`, `--help`, and `--version`. Put global options before the command for clarity. Each command has `--help`.

| Command | Purpose and options |
| --- | --- |
| `setup` | Interactive token validation, course selection, optional skill installation. |
| `auth login` | Hidden token prompt, or use the supplied environment token. |
| `auth status [--offline] [--json]` | Report credential source and availability; validate online unless `--offline`. |
| `auth logout` | Remove the saved token for this region/data directory. |
| `courses [--json]` | Fetch accessible courses. `*` marks selected courses in terminal output. |
| `sync [--course <id-or-code>] [--json]` | Sync selected courses or one course. Progress goes to stderr. |
| `status [--json] [--max-age-hours 24]` | Local paths, thread count, last completed sync, incomplete work, and freshness. |
| `search "<keywords>" [--json] [--course <id-or-code>] [--limit 10]` | Ranked matching passages, at most two per thread and one per post/reply. |
| `context "<question>" [--json] [--course <id-or-code>] [--limit 10] [--max-chars 16000]` | Matching evidence followed by available parent/original-post context, with a text budget. |
| `read <thread-id> [--json]` | Full local thread by its global Ed ID, including the reply hierarchy. |
| `reindex` | Discard/rebuild the SQLite index from Markdown, without a token or network. |
| `skill install [--target pi\|codex\|claude\|all] [--force]` | Copy the bundled skill into a user skill directory. Prompt for target when omitted. |
| `skill path` | Print the bundled `SKILL.md` location for manual installation. |

Course codes must match exactly, ignoring case. If the same code appears in multiple terms, use a numeric ID. `--course` on sync does not change your setup selection. If you have never selected courses, subsequent unscoped syncs use the courses previously synced explicitly. Archived course access still depends on Ed permissions.

```sh
ed-recall courses --json
ed-recall sync --course CS101
ed-recall search "extension deadline" --course CS101 --limit 6
ed-recall context "Are late homework submissions accepted?" --course CS101 --json
ed-recall read 987654 --json
```

Use a returned `threadId` for `read`, not the course's displayed `#42` thread number. Unfiltered retrieval searches all archived courses, including ones no longer selected for sync, and reports their freshness; use `--course` to narrow it. Paths, IDs, source URL, author role when available, and post dates accompany retrieved passages. Lower SQLite BM25 ranks are better; they are not confidence scores. Search tokenizes a query into words and matches them with OR after filtering common question words. It is lexical search, with no embedding model or external AI API. Try synonyms or shorter keywords when necessary.

`context` retrieves evidence; it does not generate an answer. Its text budget counts JavaScript string characters, not model tokens or JSON metadata. A `truncated` passage needs `read` for the full text. Large individual replies are indexed in chunks, and the best chunk is returned. Quoted shell arguments preserve spaces; use shell-appropriate escaping for embedded quotes and special characters.

Structured commands emit a single JSON object on stdout with `schemaVersion: 1`; diagnostics/progress use stderr. Search returns `results`; context returns `passages`, `evidenceFound`, and budget information. Both include `freshness`. JSON errors use `{ "schemaVersion": 1, "error": { "message": "..." } }`. Exit code `0` means success, including a search with no matches; `1` means an error, missing auth credential, or an incomplete sync. Never interpret no matches as proof that a topic was never discussed.

## Sync behavior and recovery

The first sync enumerates all thread pages in each selected course, fetches full details, and traverses answers and nested comments. It repeats course enumeration until two ID lists agree (up to three passes), deduplicates pinned threads, and detects pagination that makes no progress.

Later syncs **revisit every thread**, including old ones. This deliberately avoids assuming a thread's `updated_at` changes on every reply edit. Content hashes prevent unchanged Markdown and index records from being rewritten. This is more network-intensive than a timestamp shortcut; large courses can take a while. Requests run sequentially with a 500 ms minimum spacing, 30-second timeouts, and bounded backoff for network failures, HTTP 429, and server errors. Long rate-limit pauses stop the run and ask you to retry later. Requests honor your token's permissions.

Each completed thread is written atomically, indexed, then checkpointed in `sync.json`. On interruption, rerun the same sync command: it restarts course enumeration and skips threads already completed in that unfinished run. A thread is committed only after its full supported response has been collected. Successful files survive failures elsewhere. Once a run completes, the next run revisits everything again. Changes to already completed threads during an interrupted run are picked up by that next run.

The CLI records failed courses/threads and leaves the course incomplete. It never advances a failed course to a successful sync state. It recovers locks held by dead processes; a live process lock prevents concurrent archive writers. If a crash happens between the Markdown write and index commit, the next retrieval or sync reconciles the index with Markdown.

Freshness defaults to 24 hours and is based on the start of the last complete scan, not merely the last CLI invocation. It is a local estimate, not proof of current server state. The API does not give this CLI a snapshot transaction, so a rapidly changing course may require another sync.

Previously archived threads are retained if they later disappear or become inaccessible. This is a local historical archive; a successful later scan does not prove every old file is still visible on Ed. Deletions inside a fetched thread replace that thread's stored snapshot. Keep dates and current access in mind when using historical evidence.

## Agent setup and usage

Install the CLI on PATH, run `setup` and `sync`, then install the skill for the agent you use:

```sh
ed-recall skill install --target pi
ed-recall skill install --target codex
ed-recall skill install --target claude
```

Or use `--target all`. Restart the agent session if it does not discover newly installed skills. The agent needs shell access to the CLI and read/write access to the data directory; syncing also needs network access and the same OS credential store or environment variable. A sandboxed agent may need to request access according to its own permissions. You can always sync from your normal terminal and give the agent local retrieval access.

Ask:

> Using ed-recall, what did staff say about late submissions? Cite the threads.

The skill checks status, syncs when appropriate, retrieves passages, reads complete threads when needed, and cites source URLs. It distinguishes staff statements from student claims and endorsements, and explains insufficient evidence. Thread text is treated as untrusted evidence, including any instructions or code in posts.

The skill is portable Markdown with `name` and `description` frontmatter and no agent-specific tool requirement beyond running the CLI. Install locations:

| Agent | Destination |
| --- | --- |
| Pi | `~/.pi/agent/skills/ed-recall/SKILL.md` |
| Codex | `~/.codex/skills/ed-recall/SKILL.md` |
| Claude Code | `~/.claude/skills/ed-recall/SKILL.md` |

`~` means your user home directory, including on Windows. The installer leaves an identical skill alone and refuses to overwrite a modified one unless you supply `--force`. It installs only the skill file; it does not edit agent settings or run any agent.

For manual installation, run `ed-recall skill path`, create the appropriate `ed-recall` directory from the table, and copy that `SKILL.md` there. You can also copy `skills/ed-recall/SKILL.md` directly from this repository. Project-scoped alternatives are `.pi/skills/ed-recall/`, `.codex/skills/ed-recall/`, and `.claude/skills/ed-recall/`; check your agent version's discovery settings. Remove the copied skill directory to uninstall the skill.

## Data location, backups, and index rebuilding

Default data root:

| Platform | Directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%\ed-recall` |
| macOS | `~/Library/Application Support/ed-recall` |
| Linux | `$XDG_DATA_HOME/ed-recall`, or `~/.local/share/ed-recall` |

Override it with `ED_RECALL_HOME` or `--data-dir`; the flag takes precedence. `ed-recall status --json` reports exact paths. The layout is:

```text
config.json                         region, active account, course selection
accounts/<region>-<user-id>/
  archive/<course-id>/<thread-id>.md readable source archive
  index.sqlite                      rebuildable FTS5 index
  index.sqlite-wal / -shm            temporary SQLite files while open
  sync.json                         completion times and resume checkpoints
  writer.lock                       present during archive/index writes
  writer-recovery.lock              transient guard during stale-lock recovery
```

Different Ed accounts have separate archive directories. Validating a new account through login, setup, courses, or sync changes the active account; it does not mix that account's course selection with the previous one. Search is offline and uses the active local account. `auth status` checks credentials without switching archives. Switching an environment token alone does not switch offline search until an online account-binding command runs.

Markdown is the archive of record. It contains readable course/title/source/date information, JSON frontmatter, and compact passage metadata comments used to reconstruct hierarchy and the index. Preserve these metadata blocks if you edit a file. Unknown/invalid Ed XML is retained visibly in fenced source blocks, with conversion warnings. Links to images and attachments remain links; their files are not downloaded. Anonymous authors remain anonymous, and unavailable roles are not invented.

Back up the data root when no sync is running. Tokens must be restored separately through login or environment injection. You can discard/rebuild the database using `ed-recall reindex`; offline search also notices changed/new Markdown and reconciles the index automatically. If an archive file is malformed, retrieval reports the error rather than silently dropping it. Treat generated Markdown as managed snapshots: a later sync can overwrite manual edits.

Archive content may include private posts visible to your account. Files use user-only modes on POSIX; Windows uses the inherited permissions of your user data directory. The archive itself is not encrypted by this CLI. Keep backups and custom directories private. Avoid committing tokens or archives. This repository's `.gitignore` includes `.env*`, token filenames, `archive/`, `.ed-recall/`, `*.sqlite*`, and `*.db*`; add your custom data-directory path if you place it inside a repository. `.gitignore` does not protect files already tracked by Git.

Uninstall the CLI with `npm uninstall --global ed-recall`. Remove copied skills separately. To remove local data, inspect the exact path from `status`, stop running commands, log out for each credential scope you used, and remove that data directory yourself.

## API limitations

Ed describes its API as beta, and thread routes are incompletely documented. This project isolates wire-format handling in `src/core/api.mjs`. It uses API-token Bearer authentication, `GET /api/user`, paginated course thread listings, and thread-detail responses. It does not claim Ed guarantees these routes.

The initial adapter and representative synthetic fixtures were checked against public client source and documentation on 2026-09-30, **not against live Ed responses**. See [API evidence and assumptions](docs/API.md) for sources and the exact distinctions. Observed documentation shows recursive `answers`/`comments` arrays in thread details. The adapter also follows explicit same-host `items`/`next` collection envelopes as a defensive extension, tested with synthetic fixtures. Those envelopes are not claimed as an observed Ed reply-pagination format. Unknown continuation shapes, missing required collections, and mismatched reply counts fail visibly. Real megathread pagination may require an adapter change after live inspection.

Other limits: no attachment download or OCR, no lessons/chat/private messages, no semantic embeddings, no browser UI, no automatic schedule, and no guarantee of an answer when the archive lacks relevant evidence. Future browser reuse applies to fetch/normalization modules; browser CORS, authentication, and persistence still need separate design. Only the Windows execution environment was exercised during development. A synthetic credential was successfully written, read, and deleted through Windows Credential Manager; macOS/Linux credential-store behavior and real Ed tokens still need platform/account smoke testing.

## Manual smoke test with your Ed account

Do not paste a token into an issue, chat, command argument, or committed fixture. Use the hidden prompt. Run these commands after installing the local tarball, replacing the course code and thread ID with your real values:

```sh
ed-recall setup
ed-recall auth status
ed-recall courses --json
ed-recall sync --course CS101 --json
ed-recall status --json
ed-recall search "late submissions" --course CS101 --json
ed-recall context "What did staff say about late submissions?" --course CS101 --json
ed-recall read 987654 --json
ed-recall sync --course CS101 --json
ed-recall reindex
ed-recall search "late submissions" --course CS101 --json
```

Verify these cases in Ed's web interface and the local Markdown:

1. A course with over 100 accessible threads: oldest/newest threads and pinned threads all appear once in the archive. A course with fewer threads cannot verify multi-page listing behavior.
2. A thread with an original post, answers, comments, and nested comments: compare the content, reply count, hierarchy, author roles, code/math, dates, and URL. Include a large thread/megathread to validate whether Ed paginates replies. A small thread cannot verify reply pagination.
3. Where you are allowed to post, add a nested comment to a test thread, sync, then edit that comment and sync again. Confirm both the Markdown and search reflect the edit and no duplicate file/passages remain.
4. Interrupt a sync with Ctrl+C after several completed threads, rerun it, and confirm it resumes and finishes. A second unchanged sync should report `changed: 0` unless Ed content really changed.
5. Confirm returned URLs open the right course and thread; a new terminal session can authenticate with the saved credential; local search works without a token; rebuilding the database preserves retrieval.
6. Install the skill for your agent and ask the example question. Check each claim against the cited passages. Test an unrelated question and expect an insufficient-evidence response.

For a schema failure, inspect the relevant response structure in your own browser developer tools without copying session cookies or authorization headers. Report the route, HTTP status, error message, and a sanitized structural example. Remove private text, names, tokens, and identifying IDs before sharing fixtures. The CLI uses only token-authenticated GET requests; it never creates the test posts for you.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| PowerShell says scripts are disabled | Use `npm.cmd` and `ed-recall.cmd`. |
| `No such built-in module: node:sqlite` or FTS5 unavailable | Install a supported standard Node.js 24+ distribution and rerun the build check. |
| Missing keyring/native module, locked credential store | Reinstall without `--omit=optional`, unlock your store, or supply `EDSTEM_TOKEN`. No plaintext credential is saved as a fallback. |
| HTTP 401 | Check region, token validity/revocation, and whether `EDSTEM_TOKEN` overrides a saved token. Run login again. |
| HTTP 403/404 | Verify course/thread access in Ed; check whether the thread was deleted or permissions changed. The archive may still contain an older snapshot. |
| HTTP 429 or long rate-limit pause | Wait before retrying; rerun sync to resume. Do not run multiple sync processes. |
| Missing/unsupported collections, reply-count mismatch | The beta API differs from the tested shape. Keep the error and run the manual comparison; this thread will remain incomplete until the adapter is updated. |
| Pagination does not progress or listing keeps changing | Retry later. The CLI refuses to label that scan complete. |
| No matching evidence | Check status and course selection, sync, try shorter keywords/synonyms, or read a known thread directly. |
| Database corrupt or unreadable | Stop other commands and run `ed-recall reindex`; it rebuilds from Markdown. |
| Writer lock remains | Dead process locks normally recover. If a stale/reused PID, malformed lock, or interrupted recovery prevents progress, confirm no ed-recall process is running, then remove only the reported `writer.lock` or `writer-recovery.lock`. |
| Skill not discovered | Confirm the destination file, restart the agent, and check its version-specific skill discovery settings and PATH. |

## Development and verification

```sh
npm ci
npm test
npm run build
npm pack --dry-run
```

The package ships executable ES modules, so `build` verifies JavaScript syntax, the bundled skill, and FTS5 availability without a transpilation step. Tests use synthetic HTTP fixtures, temporary archives, real SQLite, mocked credential storage, and CLI subprocesses. They cover pagination, nested content, incremental refresh, recovery, token handling, conversion, retrieval, JSON, account isolation, and skill installation. They do not contact Ed or read your saved token. The optional platform smoke test is documented in `docs/API.md`.

Core entry point for reuse: `ed-recall/core` exports `EdClient`, `EdError`, `regions`, `validRegion`, and `toMarkdown`. These modules avoid filesystem, keyring, SQLite, and CLI imports. Fetch and sleep are injectable for tests. Public CLI JSON has `schemaVersion: 1`; Ed's external response shapes remain internal adapter details.
