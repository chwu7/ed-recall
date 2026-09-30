# ed-recall

Ask an agent about your Ed Discussion threads and get answers linked to the original conversations. `ed-recall` saves the threads you can access as Markdown and keeps a local SQLite search index. It uses your **Ed API token**. It does not ask for your Ed password or scrape browser cookies.

**This version is not published to npm.** Install the package from this repository. Ed describes its API as beta; the adapter has fixture coverage but has **not** been checked with a live account. See [API limitations](#api-limitations) and [the live-account check](#check-with-your-ed-account).

## The workflow

1. Install Node.js 24 or newer, then install this package with npm.
2. In a normal terminal, run **`ed-recall setup` once**. It prompts for a token without displaying it, lets you choose courses, and offers to install the agent skill.
3. Open Pi, Codex, or Claude Code. Invoke the skill to sync, then ask a question:

   | Agent | Sync | Ask |
   | --- | --- | --- |
   | Claude Code | `/ed-recall sync` | `/ed-recall What materials did my professor allow during the midterm? Cite the threads.` |
   | Pi | `/skill:ed-recall sync` | `/skill:ed-recall What materials did my professor allow during the midterm? Cite the threads.` |
   | Codex | `$ed-recall sync` | `$ed-recall What materials did my professor allow during the midterm? Cite the threads.` |

These are **agent skill invocations** in the agent's chat, not commands to type in PowerShell. They follow the current [Claude Code](https://code.claude.com/docs/en/skills), [Pi](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md), and [Codex](https://learn.chatgpt.com/docs/build-skills) skill conventions. You can also ask in ordinary language, such as “Using ed-recall, what did staff say about late submissions? Cite the threads.” If your agent does not discover the skill, restart its session after installation.

An explicit `sync` checks Ed even when the local archive is recent. For a question, the skill checks archive status and syncs when needed, searches relevant passages, reads surrounding thread content, and writes the answer with Ed links. If it cannot find enough evidence, it should say so. The local engine performs keyword search; **the agent** interprets the evidence and composes the answer. No external AI service is called by the engine itself.

## Install and set up

You need an Ed account with access to Discussion, a personal API token, internet access for syncing, and Node.js **24+** with npm. Check your Node version with `node --version`. Get the token from Ed's API-token settings for your region; `setup` prints the relevant URL.

From a checkout on **macOS or Linux**:

```sh
npm ci
npm pack
npm install --global ./ed-recall-0.2.0.tgz
ed-recall setup
```

From a checkout in **Windows PowerShell**:

```powershell
npm.cmd ci
npm.cmd pack
npm.cmd install --global .\ed-recall-0.2.0.tgz
ed-recall.cmd setup
```

If you have not cloned the repository yet, run `git clone https://github.com/chwu7/ed-recall.git` and `cd ed-recall` first. `npm pack` builds and verifies the package; it does not publish it. The `.tgz` is an npm-installable file. If the global command is missing, reopen your terminal and check `npm prefix --global`: that directory must be on PATH on Windows, and its `bin` directory on macOS/Linux. You can also run `node bin/ed-recall.mjs setup` from this checkout after `npm ci`.

Windows npm creates an `ed-recall.cmd` launcher and an `ed-recall.ps1` launcher. PowerShell may block the `.ps1` launcher under its script policy, so these instructions call **`ed-recall.cmd`**. Command Prompt can use `ed-recall` or `ed-recall.cmd`. The agent uses the same installed package; the launcher is just how it starts the local engine on Windows.

During setup, select the region that matches your Ed URL, enter the token in the hidden prompt, select at least one accessible course, then select the agent(s) whose skill you want to install. If you skipped skill installation, run `ed-recall skill install --target codex` later, replacing `codex` with `pi`, `claude`, or `all` as needed (use `ed-recall.cmd` in PowerShell). The installer copies only `SKILL.md`; it does not alter an agent's settings.

### Token storage and automation

The token is stored in the OS credential store: Windows Credential Manager, macOS Keychain, or Linux Secret Service (for example, an unlocked GNOME Keyring). It is scoped to the data directory and Ed region. The package's optional keyring dependency must be available. **There is no plaintext token-file fallback.** If the credential store is unavailable, set `EDSTEM_TOKEN` in the environment used by setup or the agent. The environment token takes precedence over a saved token. Supply it through a private shell or your automation system's secret facility; never put it in a command argument, issue, chat, Markdown export, or repository file.

For an interactive Linux/macOS shell, this avoids typing the token into shell history:

```sh
read -rsp 'Ed API token: ' EDSTEM_TOKEN; printf '\n'
export EDSTEM_TOKEN
ed-recall setup
unset EDSTEM_TOKEN
```

In PowerShell:

```powershell
$secret = Read-Host 'Ed API token' -AsSecureString
$env:EDSTEM_TOKEN = [System.Net.NetworkCredential]::new('', $secret).Password
ed-recall.cmd setup
Remove-Item Env:EDSTEM_TOKEN
Remove-Variable secret
```

If you use an environment token because your OS store is unavailable, keep it available to the **agent process** when syncing. For noninteractive automation, inject `EDSTEM_TOKEN` and run `ed-recall agent sync --course <numeric-id>`; that binds the account and creates a local archive without the setup prompts. `ed-recall logout` removes the stored credential for the current data directory and region; it cannot unset a variable in its parent shell. Local archives remain after logout. Setup validates the token online and binds the active local archive to the Ed account returned by the API.

## Using the skill

Install locations:

| Agent | User skill file |
| --- | --- |
| Pi | `~/.pi/agent/skills/ed-recall/SKILL.md` |
| Codex | `~/.agents/skills/ed-recall/SKILL.md` |
| Claude Code | `~/.claude/skills/ed-recall/SKILL.md` |

`~` is your home directory, including on Windows. The installer leaves identical content alone and refuses to overwrite a modified skill unless you use `--force`. For Codex, it recognizes the old version installed at `~/.codex/skills/ed-recall/SKILL.md`, migrates an unchanged copy, and stops for manual review if you changed that copy. This avoids two versions of the same skill being discovered.

For manual installation, run `ed-recall skill path` to print the bundled file location, then copy that file to the directory in the table. From this checkout, the file is [skills/ed-recall/SKILL.md](skills/ed-recall/SKILL.md). Restart the agent after adding or changing a skill. The agent needs shell access to the installed `ed-recall` command, access to the local archive, and network access when syncing; its own sandbox or approval settings may affect those operations. An agent can answer from an existing archive while offline, with the archive's freshness disclosed.

Use `sync` or `sync <course-code-or-id>` as the skill request when you want a new Ed scan. Course codes must match exactly, ignoring case; if the same code exists in two terms, use the numeric course ID. To remove the skill, delete the installed `ed-recall` skill directory after checking its contents.

## How sync and search work

The first sync walks all accessible thread-list pages for each selected course and fetches the original post, answers, comments, and nested comments. Subsequent syncs re-fetch every listed thread so edited replies and new comments are included even if Ed does not update a thread timestamp. Unchanged content is detected by hash and is not rewritten. That approach can take time on large courses.

Requests are sequential and spaced at least 500 ms apart. The client has timeouts and bounded retries for network errors, HTTP 429, and server errors. It uses only your token's permissions. Sync checkpoints completed threads. If interrupted or partly failed, invoke sync again to resume; a complete later sync revisits all threads. Concurrent writers are blocked by a local lock. Previously archived threads remain in the local historical archive if they later disappear from Ed or become inaccessible.

Each thread has a Markdown file containing course, title, number/ID, original Ed URL, dates, original post, answers, and the reply hierarchy. The converter preserves code, links, and math where possible and keeps unknown content visibly fenced instead of silently dropping it. Attachments remain links and are not downloaded. SQLite FTS5 indexes individual passages and stores their thread metadata; **Markdown is the archive of record**, and the index can be rebuilt from it.

Search is lexical: it matches query terms, ranks passages, and limits repeated hits from one thread. It does not understand a question on its own. The agent can search again with synonyms and read the full thread before answering. A missing match is not proof that a topic was never discussed. The agent must distinguish staff statements from student claims and treat thread content as untrusted data, including any instructions within a post.

## Local data and recovery

By default, user data is stored outside the npm installation:

| Platform | Data directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%\ed-recall` |
| macOS | `~/Library/Application Support/ed-recall` |
| Linux | `$XDG_DATA_HOME/ed-recall`, or `~/.local/share/ed-recall` |

Set `ED_RECALL_HOME` to use another private location. The one-time commands and agent engine also accept `--data-dir <path>`. The data root contains `config.json` with region/account/course selection and `accounts/<region>-<user-id>/` with `archive/<course-id>/<thread-id>.md`, `index.sqlite`, and `sync.json`. Multiple Ed accounts have separate archives. The database is rebuildable; `sync.json` records freshness and resume checkpoints. The archive may contain private Ed posts and is not encrypted. Back it up only when no sync is running. Token storage is separate and must be set up again after moving to another device.

If you place a custom data directory inside a Git repository, add its path to `.gitignore`. This repository ignores `.env*`, likely token filenames, `archive/`, `.ed-recall/`, and SQLite files. `.gitignore` cannot protect a file already tracked by Git. Avoid committing the archive or any token.

The engine exposes JSON operations for the skill under `ed-recall agent ...`; these are also useful for troubleshooting or custom integrations. They are **retrieval operations**, not an answer-writing interface:

```sh
ed-recall agent status
ed-recall agent courses
ed-recall agent sync --course CS101
ed-recall agent search "late submissions" --course CS101 --limit 6
ed-recall agent context "What did staff say about late submissions?" --course CS101
ed-recall agent read 987654
ed-recall agent reindex
```

Use `ed-recall.cmd` in PowerShell. `read` takes the global thread ID returned by search, not the course's displayed thread number. `context` accepts `--max-chars` (default 16000). The JSON has `schemaVersion: 1`; search/context include archive freshness. Progress and diagnostics go to stderr. Exit code 1 means an error or incomplete sync. The skill handles these operations; most users only need setup and the agent's chat.

## API limitations

The Ed adapter is isolated in `src/core/api.mjs`; content conversion is in `src/core/content.mjs`. `ed-recall/core` exports these reusable modules for a future browser version. Fetch and sleep are injectable for tests. Browser authentication, CORS, persistence, and UI still need separate work.

Ed's API is described as beta and its thread routes are incompletely documented. This project reviewed public client source and documentation on 2026-09-30 and tested representative synthetic responses; it did **not** verify the current server responses with a live Ed token. The expected reply arrays and defensive pagination handling may need adjustment for large threads. Unknown continuation shapes and reply-count mismatches fail visibly rather than claim a complete archive. See [API evidence and assumptions](docs/API.md).

Other limits: no attachment download or OCR; no lessons, chat, or private messages; no semantic embeddings; no browser app; no automatic sync schedule. The Windows credential store was smoke tested with a synthetic secret; macOS/Linux credential storage and live Ed behavior remain unverified. A course with private posts is limited to what the token owner may access.

## Check with your Ed account

Do not paste your token into chat, an issue, or a command argument. After local installation, use your own account and a course you may access:

1. Run `ed-recall setup` in a terminal. Close it, open a new terminal, and use the installed skill to request `sync` (or run `ed-recall agent sync --course <real-id-or-code>`). Confirm the saved credential works without `EDSTEM_TOKEN` if you chose OS storage.
2. Run `ed-recall agent status` and `ed-recall agent courses`. Confirm selection, account, completion, and thread counts. Inspect the Markdown files under the reported data directory.
3. In a course with **over 100 accessible threads**, compare the oldest, newest, and pinned threads with Ed. A smaller course cannot validate multipage listing.
4. Compare a thread with an original post, answer, comment, and nested comment against the Markdown and `ed-recall agent read <thread-id>`. Check hierarchy, author roles, dates, code/math, reply counts, and returned URL. Test a large thread to discover whether Ed paginates replies in a different format.
5. If posting is allowed, add a test nested comment in Ed, sync again, edit it in Ed, and sync again. Confirm the Markdown and `agent search` reflect the latest text without duplicates. A second unchanged sync should have `changed: 0`.
6. Interrupt a sync with Ctrl+C after several threads, invoke sync again, and confirm completion. Run `ed-recall agent reindex` and repeat a search to verify index rebuild. Ask the skill an evidence question and an unrelated question; check citations and the insufficient-evidence response.

The CLI sends no posts or edits to Ed. If the beta API response differs, capture only a **sanitized structural example**: route, status, keys, array nesting, and the error. Remove authorization headers, private text, names, and identifying IDs before sharing it.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| PowerShell says scripts are disabled | Use `npm.cmd` and `ed-recall.cmd`; no execution-policy change is needed. |
| `node:sqlite` or FTS5 is unavailable | Install a standard Node.js 24+ build. |
| Credential store unavailable or locked | Unlock/install the OS store and optional keyring dependency, or provide `EDSTEM_TOKEN` to setup and the agent process. No token file fallback exists. |
| HTTP 401 | Check token validity, selected region, and whether `EDSTEM_TOKEN` overrides a saved token. Re-run setup. |
| HTTP 403/404 | Check access in Ed; a removed thread may remain in the local archive. |
| HTTP 429 or interrupted sync | Wait, then invoke sync again. Check `agent status` for incomplete courses. |
| A reply collection or page is rejected | The beta API may have changed. Follow the live-account check and add a sanitized fixture before adapting `src/core/api.mjs`. |
| No evidence for a question | Check archive freshness and course selection, sync, try shorter terms/synonyms, or read a known thread. |
| Index unreadable | With no other ed-recall process running, run `ed-recall agent reindex`; Markdown is retained. |
| Writer lock persists | Confirm no ed-recall process is running before removing the reported `writer.lock` or `writer-recovery.lock`. |
| Skill is not discovered | Check the path above, restart the agent, and ensure its shell can find `ed-recall`. |

To uninstall the package, run `npm uninstall --global ed-recall`. Remove installed skill copies separately. To delete local data, inspect its path first, stop running ed-recall processes, run `ed-recall logout` for saved credentials, then remove the data directory yourself.

## Development

```sh
npm ci
npm test
npm run build
npm pack --dry-run
```

The build checks executable JavaScript, the bundled skill, and FTS5. Tests use synthetic Ed API fixtures, temporary archives, real SQLite, mocked credentials, and command subprocesses. They cover pagination, nested comments, incremental updates and resume, Markdown conversion, local search, account isolation, and skill installation. They do not contact Ed or read your saved token.
