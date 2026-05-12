# Time Logging Bot

A Telegram bot for logging time on issues in a GitHub Project (Projects v2).

The bot walks you through a short conversation — issue → date → minutes → remarks — and writes the values to four custom fields on the matching project item.

## Setup

```sh
npm install
cp .env.example .env
# fill in TELEGRAM_BOT_TOKEN, GITHUB_TOKEN, GITHUB_PROJECT_NUMBER, etc.
npm run dev
```

### Environment variables

| Var | Required | Notes |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | yes | From [@BotFather](https://t.me/BotFather) |
| `GITHUB_TOKEN` | yes | Personal access token (see scopes below) |
| `GITHUB_OWNER` | yes | User or org that owns the project (default `blg-abdullah`). Used as the implicit owner for `repo#123` shorthand. |
| `GITHUB_PROJECT_NUMBER` | yes | Project number from the project URL |
| `GITHUB_REPO` | no | Optional fallback repo for bare-number input (`123`) before any repo has been used in this session |

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
- `/log` — start a worklog flow
- `/cancel` — cancel the current flow

The flow:

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

The target issue (sub-issue if created, otherwise the parent) is also auto-assigned to `blg-abdullah`. `addAssigneesToAssignable` is used so existing assignees on the parent are preserved.

The bot remembers your last 5 repos per Telegram user (in memory) and surfaces them as quick-pick buttons on the next `/log`. The worklog owner is always set to `blg-abdullah`. If the issue isn't already in the project, it's added automatically when you confirm.

## Project layout

```
src/
  bot.ts       # telegraf setup, command handlers, conversation flow
  github.ts    # @octokit/graphql client and field discovery
  state.ts     # in-memory per-user conversation state
  utils.ts     # date and issue-input parsing
index.ts       # entry point
.env.example
```

State is held in a `Map` keyed by Telegram user ID — restart the bot and any in-progress flows are lost.
