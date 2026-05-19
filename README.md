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
| `TELEGRAM_ALLOWED_USERNAMES` | yes | Comma-separated list of Telegram usernames allowed to use the bot (with or without leading `@`, case-insensitive). Updates from anyone else are silently dropped. |
| `GITHUB_TOKEN` | yes | Personal access token (see scopes below) |
| `GITHUB_OWNER` | yes | User or org that owns the project (default `blg-abdullah`). Used as the implicit owner for `repo#123` shorthand. |
| `GITHUB_PROJECT_NUMBER` | yes | Project number from the project URL |
| `GITHUB_REPO` | no | Optional fallback repo for bare-number input (`123`) before any repo has been used in this session |
| `WEBHOOK_URL` | no (deploy only) | Public HTTPS URL of the deployed service (e.g. `https://my-bot.onrender.com`). When set, the bot runs in webhook mode and binds an HTTP server to `$PORT`. Leave blank for local long-polling. |
| `WEBHOOK_SECRET` | no | Overrides the secret path segment used for the webhook. Defaults to a hash of `TELEGRAM_BOT_TOKEN`. Anyone with this value can POST fake updates. |
| `PORT` | no | Provided by the host (Render sets this). Defaults to `3000` locally. |

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
- `/day [date]` — total minutes logged for a day (default today). Accepts `today`, `yesterday`, or `YYYY-MM-DD`.
- `/week` — current week (Mon–Sun), grouped by day with per-day totals
- `/month` — current calendar month, grouped by date with per-day totals
- `/range` — prompts for a start and end date, then reports entries grouped by day
- `/fulldays` — prompts for a start and end date, then reports the count of days with ≥480 mins logged and lists partial days (>0, <480 mins)
- `/cancel` — cancel the current flow

Summary commands query GitHub issue search filtered by assignee (`blg-abdullah`) plus the project's `Worklog (Date)` / `Worklog (mins)` field values. Issue numbers in the output are Markdown links to the GitHub issue.

The log flow:

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

## Deploying on Render

The bot supports two modes:

- **Local dev** — long-polling. Just `npm run dev`. Leave `WEBHOOK_URL` unset.
- **Production** — Telegram webhooks over HTTPS. The bot starts an HTTP server bound to `$PORT` with a `/health` route and a secret webhook path.

### One-click via blueprint

A `render.yaml` is included. From the Render dashboard, choose **New → Blueprint** and point it at this repo. Render will create a Web Service with the right build/start commands and prompt you to fill the env vars listed in the blueprint (all marked `sync: false`).

After the first deploy:

1. Copy the service URL (e.g. `https://time-logging-bot.onrender.com`).
2. Set `WEBHOOK_URL` to that URL in the service's environment.
3. Trigger a redeploy. On boot the bot calls `setWebhook` with `${WEBHOOK_URL}/tg/<secret>` and Telegram starts delivering updates.

### Manual setup

If you'd rather click through the dashboard:

- **Type**: Web Service
- **Runtime**: Node
- **Build command**: `npm install && npm run build`
- **Start command**: `npm start` (runs `node dist/index.js`)
- **Health check path**: `/health`
- **Env vars**: same as the table above. `WEBHOOK_URL` must be the service's public URL.

### Free tier caveat

Render's free Web Services spin down after ~15 min of inactivity. With webhooks this is mostly fine — Telegram retries undelivered updates, so the next message wakes the service (with a cold-start delay of a few seconds). For a personal worklog bot this is usually acceptable. If you need always-on, upgrade the plan or switch to a Background Worker.
