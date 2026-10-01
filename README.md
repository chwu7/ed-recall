# ed-recall

Ask Pi, Codex, or Claude Code about your Ed Discussion threads and get answers linked to the original conversations. `ed-recall` archives accessible posts and replies as Markdown and provides local search using your **Ed API token**.

Ed's API is in beta. The adapter has automated tests and a limited US live-account check; see [API evidence and limitations](docs/API.md).

## Install and set up

Requires **Node.js 24+**, npm, Git, and an Ed account with access to Discussion.

**macOS, Linux, or Windows Command Prompt:**

```sh
npm install --global github:chwu7/ed-recall
ed-recall setup
```

**Windows PowerShell:**

```powershell
npm.cmd install --global github:chwu7/ed-recall
ed-recall.cmd setup
```

Create a personal token at [Ed's API-token settings (US)](https://edstem.org/us/settings/api-tokens). During setup, choose your region, enter the token in the hidden prompt, select courses, and install the skill for your agent. Later setup runs offer **Use saved token** (default) or **Enter a new token**. A replacement is saved only after validation. Setup prints the token-settings URL for your region.

Add courses directly through the skill with `add <course-id-or-code>`; rerun setup to change the full selection. If you skipped skill installation, run `ed-recall skill install --target pi`, using `codex`, `claude`, or `all` as needed. Restart your agent after installing or updating its skill.

## Use the skill

| Request | Pi | Codex | Claude Code |
| --- | --- | --- | --- |
| Sync | `/skill:ed-recall sync` | `$ed-recall sync` | `/ed-recall sync` |
| Resume | `/skill:ed-recall resume` | `$ed-recall resume` | `/ed-recall resume` |
| Refresh | `/skill:ed-recall refresh` | `$ed-recall refresh` | `/ed-recall refresh` |
| List courses | `/skill:ed-recall list` | `$ed-recall list` | `/ed-recall list` |
| Add a course | `/skill:ed-recall add <course>` | `$ed-recall add <course>` | `/ed-recall add <course>` |
| Ask a question | `/skill:ed-recall <question>` | `$ed-recall <question>` | `/ed-recall <question>` |

For example: `/skill:ed-recall What are the midterm dates for 142A and what materials are allowed?` You can also ask in ordinary language; answers include links to supporting Ed threads.

- **Sync** skips courses successfully synced within 24 hours. It resumes pending work and refreshes stale courses when no batch is pending.
- **Resume** retries unfinished courses, skipping completed courses regardless of age.
- **Refresh** starts a new scan and re-fetches all threads, including recently synced ones.
- **Add** saves a course to your selection and immediately syncs only that course. You can give its ID/code or ask naturally; the agent shows choices if the course is unclear. Already selected courses are not duplicated, and the selection is preserved if sync is interrupted.
- **List** shows selected courses, terms and IDs, sync status, archive counts, last successful sync times, and the newest archived thread with its date and Ed link. It works offline and includes failures or coverage warnings. The newest thread is determined by when it was posted, rather than last edited.

To limit sync, resume, or refresh to one course, append its ID or exact course code: `/skill:ed-recall refresh 80155`. Use an ID if the same code exists in multiple terms. Questions can name the course naturally.

### Skill locations

| Agent | Skill file |
| --- | --- |
| Pi | `~/.pi/agent/skills/ed-recall/SKILL.md` |
| Codex | `~/.agents/skills/ed-recall/SKILL.md` |
| Claude Code | `~/.claude/skills/ed-recall/SKILL.md` |

The installer protects modified copies; use `--force` when intentionally replacing one. `ed-recall skill path` prints the bundled skill location.

## Credentials and local data

Tokens are saved in Windows Credential Manager, macOS Keychain, or Linux Secret Service. If the store is unavailable, supply `EDSTEM_TOKEN` to setup and the agent process; it overrides a saved token. No plaintext token file is created. Keep tokens out of chat, command arguments, and Git.

| Platform | Default data directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%\ed-recall` |
| macOS | `~/Library/Application Support/ed-recall` |
| Linux | `$XDG_DATA_HOME/ed-recall`, or `~/.local/share/ed-recall` |

Override the location with `ED_RECALL_HOME` or `--data-dir <path>`. Each account has its own Markdown archive, rebuildable SQLite index, and sync checkpoints. Archives may contain private posts and are not encrypted; keep them out of Git and back them up while no sync is running.

`ed-recall logout` removes the saved token and preserves the archive. Environment tokens must be unset separately.

## Recovery and CLI

Large courses can take minutes. Sync saves progress after each thread and retries transient network/server failures. The skill attempts bounded recovery after timeouts; if it stops, use `resume`. Other thread failures are recorded while remaining threads and courses continue. Authentication errors or exhausted rate limits stop the run.

The underlying CLI returns JSON and is useful for troubleshooting or integrations:

```sh
ed-recall agent list
ed-recall agent status
ed-recall agent courses
ed-recall agent add 80155
ed-recall agent sync --course 80155
ed-recall agent sync --resume
ed-recall agent sync --refresh --course 80155
ed-recall agent search "midterm" --course 80155 --limit 6
ed-recall agent context "What materials are allowed?" --course 80155
ed-recall agent read 7138070
ed-recall agent reindex
```

`list` reads selected courses locally; `courses` fetches all accessible courses from Ed. CLI `add` saves the selection; the skill follows it with a targeted sync. `read` takes a thread's global ID. `reindex` rebuilds search from Markdown. Progress goes to stderr; exit code 1 means an error or incomplete sync. Warnings alone return code 0. `--resume` and `--refresh` cannot be combined. In PowerShell, use `ed-recall.cmd`.

## Limitations

Search uses keywords; the agent interprets evidence and writes the answer. Attachments remain links, with no downloads or OCR. Lessons, chat, private messages, and automatic scheduled syncing are not supported.

Unexpected reply counts produce persistent coverage warnings while accessible replies are archived. Unsupported continuation or reply structures leave the affected thread unfinished. A successful sync can still have uncertain reply coverage. Previously archived threads are retained if they later disappear from Ed.

## Troubleshooting

| Problem | Action |
| --- | --- |
| Command or skill missing | Reopen the terminal or restart the agent; check PATH and the skill location above. |
| PowerShell blocks scripts | Use `npm.cmd` and `ed-recall.cmd`. |
| SQLite/FTS5 unavailable | Install a standard Node.js 24+ build. |
| Credential store unavailable | Unlock the store and check the optional keyring dependency, or supply `EDSTEM_TOKEN`. |
| HTTP 401 | Check token validity, region, and environment overrides; rerun setup. |
| HTTP 403/404 | Check course/thread access in Ed. |
| Interrupted sync or HTTP 429 | Check status, wait if rate limited, then resume. If `syncRunning` is true, let the existing writer finish. |
| Coverage warning or rejected replies | Compare with Ed; report a sanitized structural example without private text or credentials. |
| Weak search results | Try shorter keywords or synonyms and read relevant threads. |
| Index unreadable | Stop other writers, then run `ed-recall agent reindex`. |
| Persistent writer lock | Confirm no ed-recall process is running before removing the reported lock file. |

## Development

```sh
npm ci
npm test
npm run build
npm pack --dry-run
```

Tests use synthetic API fixtures, temporary archives, SQLite, and mocked credentials; they do not contact Ed. For a local install, run `npm pack` and install the generated tarball globally. API assumptions and verification details are in [docs/API.md](docs/API.md).
