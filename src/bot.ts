import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { Telegraf, Markup } from 'telegraf';
import { GitHubClient, ProjectInfo, findField } from './github';
import {
  getRecentRepos,
  getState,
  rememberRepo,
  resetState,
  setState,
} from './state';
import {
  formatDate,
  getMonthRange,
  getWeekRange,
  parseDate,
  parseIssueInput,
} from './utils';

const FIELD_DATE = 'Worklog (Date)';
const FIELD_MINS = 'Worklog (mins)';
const FIELD_REMARKS = 'Worklog (Remarks)';
const FIELD_OWNER = 'Worklog Owner (blg-xxxx)';
const OWNER_VALUE = 'blg-abdullah';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export async function startBot(): Promise<void> {
  const token = requireEnv('TELEGRAM_BOT_TOKEN');
  const githubToken = requireEnv('GITHUB_TOKEN');
  const owner = requireEnv('GITHUB_OWNER');
  const projectNumber = Number(requireEnv('GITHUB_PROJECT_NUMBER'));
  const defaultRepo = process.env.GITHUB_REPO || '';
  const allowedUsernames = new Set(
    requireEnv('TELEGRAM_ALLOWED_USERNAMES')
      .split(',')
      .map((u) => u.trim().replace(/^@/, '').toLowerCase())
      .filter(Boolean),
  );
  if (allowedUsernames.size === 0) {
    throw new Error(
      'TELEGRAM_ALLOWED_USERNAMES must list at least one username.',
    );
  }

  if (!Number.isInteger(projectNumber) || projectNumber <= 0) {
    throw new Error('GITHUB_PROJECT_NUMBER must be a positive integer.');
  }

  const gh = new GitHubClient(githubToken);

  const project: ProjectInfo = await gh.getProject(owner, projectNumber);
  for (const name of [FIELD_DATE, FIELD_MINS, FIELD_REMARKS, FIELD_OWNER]) {
    findField(project.fields, name);
  }
  console.log(
    `Connected to project "${project.title}" (#${project.number}). Required fields verified.`,
  );

  const dateField = findField(project.fields, FIELD_DATE);
  const minsField = findField(project.fields, FIELD_MINS);
  const remarksField = findField(project.fields, FIELD_REMARKS);
  const ownerField = findField(project.fields, FIELD_OWNER);

  const assigneeUserId = await gh.getUserId(OWNER_VALUE);
  console.log(`Assignee resolved: ${OWNER_VALUE} (${assigneeUserId}).`);

  const bot = new Telegraf(token);

  bot.use(async (ctx, next) => {
    const username = ctx.from?.username?.toLowerCase();
    if (!username || !allowedUsernames.has(username)) {
      console.warn(
        `Rejected update from unauthorized user: id=${ctx.from?.id} username=${ctx.from?.username ?? '(none)'}`,
      );
      return;
    }
    return next();
  });

  bot.start((ctx) =>
    ctx.reply(
      `Hi! I help you log time on GitHub Project issues.\n\n` +
        `Connected project: ${project.title} (#${project.number})\n\n` +
        `Commands:\n` +
        `/log — start a new worklog\n` +
        `/day [date] — total minutes for a day (default today)\n` +
        `/week — minutes for this week, grouped by date\n` +
        `/month — minutes for this month, grouped by date\n` +
        `/range — minutes for a custom date range (prompts for start & end)\n` +
        `/fulldays — count days with ≥480 mins in a custom range\n` +
        `/cancel — cancel the current flow`,
    ),
  );

  bot.command('cancel', (ctx) => {
    resetState(ctx.from!.id);
    return ctx.reply('Cancelled.');
  });

  const fieldNames = { date: FIELD_DATE, minutes: FIELD_MINS };

  type Entry = Awaited<ReturnType<typeof gh.listWorklogsForAssignee>>[number];

  function formatEntries(
    entries: Entry[],
    mode: 'day' | 'multi',
  ): string {
    if (!entries.length) return 'No entries.\nTotal minutes logged: 0 mins';
    const byDate = new Map<string, Entry[]>();
    for (const e of entries) {
      const list = byDate.get(e.date) ?? [];
      list.push(e);
      byDate.set(e.date, list);
    }
    const dates = [...byDate.keys()].sort();
    const lines: string[] = [];
    let grand = 0;
    dates.forEach((d, idx) => {
      if (mode === 'multi' && idx > 0) lines.push('');
      lines.push(d);
      let dayTotal = 0;
      for (const e of byDate.get(d)!) {
        lines.push(`[#${e.issueNumber}](${e.issueUrl}): ${e.minutes} mins`);
        dayTotal += e.minutes;
      }
      grand += dayTotal;
      if (mode === 'multi') {
        lines.push(`Total minutes logged: ${dayTotal} mins`);
      }
    });
    if (mode === 'day') {
      lines.push(`Total minutes logged: ${grand} mins`);
    }
    return lines.join('\n');
  }

  const replyOpts = {
    parse_mode: 'Markdown',
    link_preview_options: { is_disabled: true },
  } as const;

  bot.command('day', async (ctx) => {
    const arg = ctx.message.text.split(/\s+/).slice(1).join(' ').trim();
    const date = arg ? parseDate(arg) : formatDate(new Date());
    if (!date) {
      return ctx.reply(
        'Invalid date. Try `/day`, `/day today`, `/day yesterday`, or `/day YYYY-MM-DD`.',
        { parse_mode: 'Markdown' },
      );
    }
    await ctx.reply(`Fetching worklogs for ${date}…`);
    try {
      const mine = await gh.listWorklogsForAssignee(
        project.id,
        OWNER_VALUE,
        owner,
        fieldNames,
        date,
        date,
      );
      await ctx.reply(formatEntries(mine, 'day'), replyOpts);
    } catch (err: any) {
      await ctx.reply(`Failed: ${err?.message ?? String(err)}`);
    }
  });

  bot.command('week', async (ctx) => {
    const { start, end } = getWeekRange();
    await ctx.reply(`Fetching worklogs for week ${start} → ${end}…`);
    try {
      const mine = await gh.listWorklogsForAssignee(
        project.id,
        OWNER_VALUE,
        owner,
        fieldNames,
        start,
        end,
      );
      await ctx.reply(formatEntries(mine, 'multi'), replyOpts);
    } catch (err: any) {
      await ctx.reply(`Failed: ${err?.message ?? String(err)}`);
    }
  });

  bot.command('range', async (ctx) => {
    const userId = ctx.from!.id;
    setState(userId, {
      step: 'awaiting_range_start',
      rangeStart: undefined,
      rangeMode: 'list',
    });
    return ctx.reply('Start date? (today / yesterday / YYYY-MM-DD)');
  });

  bot.command('fulldays', async (ctx) => {
    const userId = ctx.from!.id;
    setState(userId, {
      step: 'awaiting_range_start',
      rangeStart: undefined,
      rangeMode: 'count480',
    });
    return ctx.reply(
      'Count days with ≥480 mins logged.\nStart date? (today / yesterday / YYYY-MM-DD)',
    );
  });

  async function runRangeQuery(ctx: any, start: string, end: string) {
    await ctx.reply(`Fetching worklogs for ${start} → ${end}…`);
    try {
      const mine = await gh.listWorklogsForAssignee(
        project.id,
        OWNER_VALUE,
        owner,
        fieldNames,
        start,
        end,
      );
      await ctx.reply(formatEntries(mine, 'multi'), replyOpts);
    } catch (err: any) {
      await ctx.reply(`Failed: ${err?.message ?? String(err)}`);
    }
  }

  async function runFullDaysCount(ctx: any, start: string, end: string) {
    await ctx.reply(`Counting full days in ${start} → ${end}…`);
    try {
      const mine = await gh.listWorklogsForAssignee(
        project.id,
        OWNER_VALUE,
        owner,
        fieldNames,
        start,
        end,
      );
      const totals = new Map<string, number>();
      for (const e of mine) {
        totals.set(e.date, (totals.get(e.date) ?? 0) + e.minutes);
      }
      const sorted = [...totals.entries()].sort(([a], [b]) =>
        a.localeCompare(b),
      );
      const full = sorted.filter(([, m]) => m >= 480);
      const partial = sorted.filter(([, m]) => m > 0 && m < 480);
      const lines = [
        `Full days: ${full.length}`,
        '',
        `Partial days: ${partial.length}`,
      ];
      for (const [d, m] of partial) lines.push(`${d}: ${m} mins`);
      await ctx.reply(lines.join('\n'));
    } catch (err: any) {
      await ctx.reply(`Failed: ${err?.message ?? String(err)}`);
    }
  }

  bot.command('month', async (ctx) => {
    const { start, end } = getMonthRange();
    await ctx.reply(`Fetching worklogs for ${start.slice(0, 7)}…`);
    try {
      const mine = await gh.listWorklogsForAssignee(
        project.id,
        OWNER_VALUE,
        owner,
        fieldNames,
        start,
        end,
      );
      await ctx.reply(formatEntries(mine, 'multi'), replyOpts);
    } catch (err: any) {
      await ctx.reply(`Failed: ${err?.message ?? String(err)}`);
    }
  });

  bot.command('log', async (ctx) => {
    const userId = ctx.from!.id;
    setState(userId, {
      step: 'awaiting_issue',
      selectedRepo: undefined,
      issue: undefined,
      date: undefined,
      minutes: undefined,
      remarks: undefined,
    });
    const recent = getRecentRepos(userId);
    const lines = [
      'Which issue?',
      'Send a GitHub URL, `repo#123`, or `owner/repo#123`.',
    ];
    if (recent.length) {
      lines.push(`Bare \`123\` uses your last repo: \`${recent[0]}\`.`);
    } else if (defaultRepo) {
      lines.push(`Bare \`123\` uses default repo: \`${defaultRepo}\`.`);
    }
    const extra: Parameters<typeof ctx.reply>[1] = {
      parse_mode: 'Markdown',
    };
    if (recent.length) {
      extra.reply_markup = {
        inline_keyboard: recent.map((r) => [
          { text: r, callback_data: `pick_repo:${r}` },
        ]),
      };
    }
    await ctx.reply(lines.join('\n'), extra);
  });

  bot.action(/^pick_repo:(.+)$/, async (ctx) => {
    const userId = ctx.from!.id;
    if (getState(userId).step !== 'awaiting_issue') {
      return ctx.answerCbQuery();
    }
    const repo = ctx.match[1];
    setState(userId, { selectedRepo: repo });
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `Repo: ${repo}\nSend the issue number (e.g. \`42\`).`,
      { parse_mode: 'Markdown' },
    );
  });

  bot.action(/^subissue:(yes|no)$/, async (ctx) => {
    const userId = ctx.from!.id;
    const state = getState(userId);
    if (state.step !== 'awaiting_subissue_choice' || !state.issue) {
      return ctx.answerCbQuery();
    }
    const create = ctx.match[1] === 'yes';
    setState(userId, { createSubIssue: create, step: 'awaiting_date' });
    await ctx.answerCbQuery();
    try {
      await ctx.editMessageText(
        `Issue: #${state.issue.number} ${state.issue.title}\n` +
          `Sub-issue: ${create ? 'yes' : 'no'}`,
      );
    } catch {
      // ignore — message may not be editable
    }
    await ctx.reply(
      `Which date? (today / yesterday / YYYY-MM-DD)`,
      Markup.inlineKeyboard([
        Markup.button.callback('Use today', 'use_today'),
      ]),
    );
  });

  bot.action('use_today', async (ctx) => {
    const userId = ctx.from!.id;
    if (getState(userId).step !== 'awaiting_date') {
      return ctx.answerCbQuery();
    }
    const date = formatDate(new Date());
    setState(userId, { date, step: 'awaiting_minutes' });
    await ctx.answerCbQuery();
    await ctx.editMessageText(`Date: ${date}`);
    await ctx.reply('How many minutes? (numeric)');
  });

  bot.action('confirm', async (ctx) => {
    const userId = ctx.from!.id;
    const state = getState(userId);
    if (state.step !== 'awaiting_confirmation' || !state.issue) {
      return ctx.answerCbQuery();
    }
    await ctx.answerCbQuery();
    try {
      await ctx.editMessageReplyMarkup(undefined);
    } catch {
      // best-effort cleanup
    }
    await ctx.reply(state.createSubIssue ? 'Creating sub-issue and logging…' : 'Logging…');

    try {
      let targetIssueNumber = state.issue.number;
      let targetIssueUrl = state.issue.url;
      let targetIssueTitle = state.issue.title;
      let targetIssueId = state.issue.nodeId;
      let itemId = state.issue.projectItemId;

      if (state.createSubIssue) {
        const subTitle = `Worklog ${state.date}`;
        const subBody =
          `**Date:** ${state.date}\n` +
          `**Minutes:** ${state.minutes}\n` +
          `**Remarks:** ${state.remarks}\n` +
          `**Owner:** ${OWNER_VALUE}\n` +
          `**Parent:** ${state.issue.url}`;
        const sub = await gh.createIssue(state.issue.repoId, subTitle, subBody);
        await gh.addSubIssue(state.issue.nodeId, sub.id);
        itemId = await gh.addIssueToProject(project.id, sub.id);
        targetIssueId = sub.id;
        targetIssueNumber = sub.number;
        targetIssueUrl = sub.url;
        targetIssueTitle = sub.title;
      } else if (!itemId) {
        itemId = await gh.addIssueToProject(project.id, state.issue.nodeId);
      }

      await gh.updateDateField(project.id, itemId, dateField.id, state.date!);
      await gh.updateNumberField(
        project.id,
        itemId,
        minsField.id,
        state.minutes!,
      );
      await gh.updateTextField(
        project.id,
        itemId,
        remarksField.id,
        state.remarks!,
      );
      await gh.updateTextField(project.id, itemId, ownerField.id, OWNER_VALUE);

      await gh.addAssignees(targetIssueId, [assigneeUserId]);

      if (state.createSubIssue) {
        await gh.closeIssue(targetIssueId, 'COMPLETED');
      }

      const link = `[#${targetIssueNumber} ${escapeMd(targetIssueTitle)}](${targetIssueUrl})`;
      const subLine = state.createSubIssue
        ? `\nSub-issue of [#${state.issue.number}](${state.issue.url}), closed.`
        : '';
      await ctx.reply(
        `Logged ${state.minutes}m on ${link}${subLine}\n` +
          `Date: ${escapeMd(state.date!)}\n` +
          `Remarks: ${escapeMd(state.remarks!)}\n` +
          `Owner: ${escapeMd(OWNER_VALUE)}`,
        {
          parse_mode: 'Markdown',
          link_preview_options: { is_disabled: true },
        },
      );
    } catch (err: any) {
      await ctx.reply(`Failed to log: ${err?.message ?? String(err)}`);
    } finally {
      resetState(userId);
    }
  });

  bot.action('cancel_flow', async (ctx) => {
    resetState(ctx.from!.id);
    await ctx.answerCbQuery();
    try {
      await ctx.editMessageReplyMarkup(undefined);
    } catch {
      // ignore
    }
    await ctx.reply('Cancelled.');
  });

  bot.on('text', async (ctx) => {
    const userId = ctx.from!.id;
    const text = ctx.message.text;
    if (text.startsWith('/')) return;
    const state = getState(userId);

    switch (state.step) {
      case 'awaiting_issue': {
        const fallbackRepo =
          state.selectedRepo || getRecentRepos(userId)[0] || defaultRepo;
        const ref = parseIssueInput(text, owner, fallbackRepo);
        if (!ref) {
          return ctx.reply(
            'Could not parse. Send a GitHub URL, `repo#123`, `owner/repo#123`, or a bare number once you have a recent repo.',
            { parse_mode: 'Markdown' },
          );
        }
        try {
          const issue = await gh.getIssue(ref.owner, ref.repo, ref.number);
          const projectItem = issue.projectItems.find(
            (p) => p.projectId === project.id,
          );
          if (ref.owner === owner) {
            rememberRepo(userId, ref.repo);
          }
          setState(userId, {
            step: 'awaiting_subissue_choice',
            issue: {
              owner: ref.owner,
              repo: ref.repo,
              number: issue.number,
              title: issue.title,
              url: issue.url,
              nodeId: issue.id,
              repoId: issue.repositoryId,
              projectItemId: projectItem?.id ?? '',
            },
          });
          const note = projectItem
            ? ''
            : `\n(Will be added to "${project.title}" when you confirm.)`;
          await ctx.reply(
            `Issue: #${issue.number} ${issue.title}${note}\n\n` +
              `Create a sub-issue for this worklog?\n` +
              `(Yes = open + close a "Worklog <date>" sub-issue under this one. No = log directly on this issue.)`,
            Markup.inlineKeyboard([
              Markup.button.callback('Yes — sub-issue', 'subissue:yes'),
              Markup.button.callback('No — this issue', 'subissue:no'),
            ]),
          );
        } catch (err: any) {
          await ctx.reply(`Error: ${err?.message ?? String(err)}`);
        }
        return;
      }

      case 'awaiting_range_start': {
        const date = parseDate(text);
        if (!date) {
          return ctx.reply(
            'Invalid date. Try `today`, `yesterday`, or `YYYY-MM-DD`.',
            { parse_mode: 'Markdown' },
          );
        }
        setState(userId, { rangeStart: date, step: 'awaiting_range_end' });
        return ctx.reply(`Start: ${date}\nEnd date? (today / yesterday / YYYY-MM-DD)`);
      }

      case 'awaiting_range_end': {
        const end = parseDate(text);
        if (!end) {
          return ctx.reply(
            'Invalid date. Try `today`, `yesterday`, or `YYYY-MM-DD`.',
            { parse_mode: 'Markdown' },
          );
        }
        const start = state.rangeStart!;
        if (end < start) {
          return ctx.reply(
            `End date ${end} is before start ${start}. Send a date on or after ${start}.`,
          );
        }
        const mode = state.rangeMode ?? 'list';
        resetState(userId);
        if (mode === 'count480') {
          await runFullDaysCount(ctx, start, end);
        } else {
          await runRangeQuery(ctx, start, end);
        }
        return;
      }

      case 'awaiting_date': {
        const date = parseDate(text);
        if (!date) {
          return ctx.reply(
            'Invalid date. Try `today`, `yesterday`, or `YYYY-MM-DD`.',
            { parse_mode: 'Markdown' },
          );
        }
        setState(userId, { date, step: 'awaiting_minutes' });
        return ctx.reply(`Date: ${date}\n\nHow many minutes? (numeric)`);
      }

      case 'awaiting_minutes': {
        const mins = Number(text.trim());
        if (!Number.isFinite(mins) || mins <= 0) {
          return ctx.reply('Please send a positive number of minutes.');
        }
        setState(userId, { minutes: mins, step: 'awaiting_remarks' });
        return ctx.reply(`Minutes: ${mins}\n\nAny remarks?`);
      }

      case 'awaiting_remarks': {
        const remarks = text.trim();
        if (!remarks) {
          return ctx.reply(
            'Remarks cannot be empty. What did you work on?',
          );
        }
        const next = setState(userId, {
          remarks,
          step: 'awaiting_confirmation',
        });
        const subLine = next.createSubIssue
          ? `\nSub-issue: yes — will create & close "Worklog ${next.date}" under #${next.issue!.number}`
          : '';
        const summary =
          `Confirm worklog:\n` +
          `Issue: #${next.issue!.number} ${next.issue!.title}${subLine}\n` +
          `Date: ${next.date}\n` +
          `Minutes: ${next.minutes}\n` +
          `Remarks: ${next.remarks}\n` +
          `Owner: ${OWNER_VALUE}`;
        return ctx.reply(
          summary,
          Markup.inlineKeyboard([
            Markup.button.callback('Confirm', 'confirm'),
            Markup.button.callback('Cancel', 'cancel_flow'),
          ]),
        );
      }

      default:
        return ctx.reply('Send /log to start logging time.');
    }
  });

  bot.catch((err, ctx) => {
    console.error(`Bot error for update ${ctx.updateType}:`, err);
  });

  const webhookUrl = process.env.WEBHOOK_URL?.trim().replace(/\/$/, '');
  if (webhookUrl) {
    const port = Number(process.env.PORT || 3000);
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error('PORT must be a positive integer.');
    }
    const secretPath =
      '/tg/' +
      (process.env.WEBHOOK_SECRET?.trim() ||
        crypto.createHash('sha256').update(token).digest('hex').slice(0, 32));

    const webhookCallback = bot.webhookCallback(secretPath);
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
      }
      webhookCallback(req, res);
    });

    await new Promise<void>((resolve) => server.listen(port, resolve));
    console.log(`HTTP server listening on :${port}`);

    await bot.telegram.setWebhook(`${webhookUrl}${secretPath}`, {
      drop_pending_updates: false,
    });
    console.log(`Webhook set to ${webhookUrl}${secretPath}`);

    const shutdown = (signal: string) => {
      console.log(`Received ${signal}, shutting down…`);
      server.close();
      bot.stop(signal);
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    return;
  }

  // Local dev: long-polling. launch() resolves only when the bot stops.
  await bot.telegram.deleteWebhook({ drop_pending_updates: false }).catch(() => {});
  bot.launch().catch((err) => console.error('Bot launch error:', err));
  console.log('Bot started in polling mode.');

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

function escapeMd(s: string): string {
  return s.replace(/([\[\]()_*`])/g, '\\$1');
}
