# Time Logging Bot

A Telegram bot for logging time on issues in a GitHub Project (Projects v2).

The bot walks you through a short conversation — issue → date → minutes → remarks — and writes the values to four custom fields on the matching project item.

## Setup

```sh
npm install
cp .env.example .env
npm run gen-key                   # copy output into ENCRYPTION_KEY
# also fill TELEGRAM_BOT_TOKEN, GITHUB_OWNER, GITHUB_PROJECT_NUMBER
npm run dev
```

### Environment variables

| Var | Required | Notes |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | yes | From [@BotFather](https://t.me/BotFather) |
| `ENCRYPTION_KEY` | yes | 32-byte hex (64 chars) for AES-256-GCM encryption of stored PATs. Generate with `npm run gen-key`. **Lose this and every saved PAT becomes unrecoverable** — users will need to `/login` again. |
| `GITHUB_OWNER` | yes | User or org that owns the project. Also the implicit owner for `repo#123` shorthand. |
| `GITHUB_PROJECT_NUMBER` | yes | Project number from the project URL |
| `GITHUB_REPO` | no | Optional fallback repo for bare-number input (`123`) before any repo has been used in this session |
| `SQLITE_PATH` | no | Path for the per-user PAT database. Default `data/users.db`. |

The bot no longer needs a server-wide `GITHUB_TOKEN` — each user provides their own PAT via `/login`. PATs are encrypted with AES-256-GCM (per-record IV + auth tag) and stored in SQLite.

## GitHub token scopes

For a **classic** personal access token:

- `repo` — read issue metadata
- `project` — read & write GitHub Projects v2

For a **fine-grained** token:

- Repository permissions: **Issues: Read**
- Account permissions (or organization permissions, if the project is org-owned): **Projects: Read and write**

Create one at https://github.com/settings/tokens.

## Finding your GitHub Project number

The project URL has the form:

- `https://github.com/users/<owner>/projects/<NUMBER>` for user-owned projects
- `https://github.com/orgs/<org>/projects/<NUMBER>` for org-owned projects

The trailing `<NUMBER>` is what you put in `GITHUB_PROJECT_NUMBER`.

## Required project fields

The bot expects the project to have these custom fields (names must match exactly):

| Field name | Type |
| --- | --- |
| `Worklog (Date)` | Date |
| `Worklog (mins)` | Number |
| `Worklog (Remarks)` | Text |
| `Worklog Owner` | Text |

The bot looks up field IDs by name at startup, so it works across any project that has these fields. If any field is missing, the bot fails fast with a list of available field names.

## Usage

In Telegram:

- `/start` — welcome message
- `/login` — register or update your GitHub PAT (required before `/log`)
- `/log` — start a worklog flow
- `/cancel` — cancel the current flow

### `/login` flow

1. Send `/login`.
2. Send your PAT in the next message. The bot deletes it from chat immediately.
3. Bot validates against `viewer { login }` and asks: **GitHub username found: xyz. Is this you?** — tap **Yes** or **No**.
4. On Yes, your Telegram id + username, GitHub login, and the encrypted PAT (single base64 blob: `iv || authTag || ciphertext`) are upserted into SQLite. The GitHub user node ID needed for assignment is fetched on demand via `viewer { id }` at confirm time.

After login the `Worklog Owner` field and the issue assignee both default to your GitHub login.

### `/log` flow:

1. Send the issue. Multi-repo supported — any of these work:
   - Full URL: `https://github.com/blg-abdullah/frontend/issues/42`
   - `repo#42` or `repo/42` — uses `GITHUB_OWNER` as the org
   - `owner/repo#42` — for repos under a different owner
   - Bare `42` — uses your last-used repo (or `GITHUB_REPO` fallback)
   - Tap one of the inline **recent repo** buttons to lock the repo for this flow, then send the bare number
2. Choose: log on this issue, or open a `Worklog <date>` **sub-issue** under it.
3. Pick a date — type `today`, `yesterday`, `YYYY-MM-DD`, or tap **Use today**.
4. Send the number of minutes.
5. Send remarks (free text).
6. Tap **Confirm** on the summary.

If you chose **sub-issue**, on confirm the bot creates a new issue titled `Worklog <date>` in the parent's repo, links it via the GitHub sub-issues relationship, adds it to the project, writes the four worklog fields to the sub-issue's project item, and closes the sub-issue as completed. Sub-issue creation is deferred until confirm, so cancelling at any point leaves no debris.

The target issue (sub-issue if created, otherwise the parent) is also auto-assigned to the logged-in user via `addAssigneesToAssignable`, which preserves existing assignees on the parent.

The bot remembers your last 5 repos per Telegram user (in memory) and surfaces them as quick-pick buttons on the next `/log`. If the issue isn't already in the project, it's added automatically when you confirm.

## Project layout

```
src/
  bot.ts       # telegraf setup, command handlers, conversation flow
  github.ts    # @octokit/graphql client and field discovery
  state.ts     # in-memory per-user conversation state
  db.ts        # better-sqlite3 user store (encrypted PATs)
  crypto.ts    # AES-256-GCM encrypt/decrypt
  utils.ts     # date and issue-input parsing
index.ts       # entry point
data/users.db  # SQLite (gitignored)
.env.example
```

Conversation state is held in a `Map` keyed by Telegram user ID — restart the bot and any in-progress flows are lost. Per-user PATs persist in SQLite.
