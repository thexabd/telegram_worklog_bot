import { Telegraf, Markup, Context } from 'telegraf';
import { GitHubClient, ProjectInfo, findField } from './github';
import { decrypt, encrypt, initCrypto } from './crypto';
import { getUser, initDb, upsertUser, UserRecord } from './db';
import {
  getRecentRepos,
  getState,
  rememberRepo,
  resetState,
  setState,
} from './state';
import { formatDate, parseDate, parseIssueInput } from './utils';

const FIELD_DATE = 'Worklog (Date)';
const FIELD_MINS = 'Worklog (mins)';
const FIELD_REMARKS = 'Worklog (Remarks)';
const FIELD_OWNER = 'Worklog Owner';

const DB_PATH = process.env.SQLITE_PATH || 'data/users.db';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export async function startBot(): Promise<void> {
  const tgToken = requireEnv('TELEGRAM_BOT_TOKEN');
  const owner = requireEnv('GITHUB_OWNER');
  const projectNumber = Number(requireEnv('GITHUB_PROJECT_NUMBER'));
  const defaultRepo = process.env.GITHUB_REPO || '';

  if (!Number.isInteger(projectNumber) || projectNumber <= 0) {
    throw new Error('GITHUB_PROJECT_NUMBER must be a positive integer.');
  }

  initCrypto(requireEnv('ENCRYPTION_KEY'));
  initDb(DB_PATH);

  let projectCache: ProjectInfo | null = null;

  async function loadProject(client: GitHubClient): Promise<ProjectInfo> {
    if (projectCache) return projectCache;
    const proj = await client.getProject(owner, projectNumber);
    for (const name of [FIELD_DATE, FIELD_MINS, FIELD_REMARKS, FIELD_OWNER]) {
      findField(proj.fields, name);
    }
    projectCache = proj;
    console.log(
      `Project loaded: "${proj.title}" (#${proj.number}). Fields verified.`,
    );
    return proj;
  }

  function clientForUser(user: UserRecord): GitHubClient {
    const token = decrypt(user.encrypted_pat);
    return new GitHubClient(token);
  }

  async function requireLogin(ctx: Context): Promise<UserRecord | null> {
    const user = getUser(ctx.from!.id);
    if (!user) {
      await ctx.reply(
        'You need to register first. Send /login and follow the prompts.',
      );
      return null;
    }
    return user;
  }

  const bot = new Telegraf(tgToken);

  bot.start((ctx) =>
    ctx.reply(
      `Hi! I help you log time on GitHub Project issues.\n\n` +
        `First time? Run /login to register your GitHub PAT.\n\n` +
        `Commands:\n` +
        `/login — register or update your GitHub PAT\n` +
        `/log — start a new worklog\n` +
        `/cancel — cancel the current flow`,
    ),
  );

  bot.command('cancel', (ctx) => {
    resetState(ctx.from!.id);
    return ctx.reply('Cancelled.');
  });

  bot.command('login', async (ctx) => {
    setState(ctx.from!.id, {
      step: 'awaiting_pat',
      pendingLogin: undefined,
      selectedRepo: undefined,
      issue: undefined,
      createSubIssue: undefined,
      date: undefined,
      minutes: undefined,
      remarks: undefined,
    });
    await ctx.reply(
      'Send me your GitHub Personal Access Token.\n\n' +
        'Required scopes: `repo`, `project`.\n' +
        'Generate one at https://github.com/settings/tokens\n\n' +
        '_Your message will be deleted immediately. The PAT is stored encrypted (AES-256-GCM)._',
      { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } },
    );
  });

  bot.command('log', async (ctx) => {
    const user = await requireLogin(ctx);
    if (!user) return;

    const userId = ctx.from!.id;
    setState(userId, {
      step: 'awaiting_issue',
      selectedRepo: undefined,
      issue: undefined,
      createSubIssue: undefined,
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

  bot.action(/^login:(yes|no)$/, async (ctx) => {
    const userId = ctx.from!.id;
    const state = getState(userId);
    if (state.step !== 'awaiting_login_confirm' || !state.pendingLogin) {
      return ctx.answerCbQuery();
    }
    const choice = ctx.match[1];
    await ctx.answerCbQuery();
    try {
      await ctx.editMessageReplyMarkup(undefined);
    } catch {
      // ignore
    }

    if (choice === 'no') {
      resetState(userId);
      await ctx.reply('Cancelled. Run /login again to retry.');
      return;
    }

    const { token, login } = state.pendingLogin;
    upsertUser({
      id: userId,
      telegram_username: ctx.from!.username ?? null,
      github_login: login,
      encrypted_pat: encrypt(token),
    });
    resetState(userId);
    await ctx.reply(
      `Logged in as *${login}*. Use /log to start logging time.`,
      { parse_mode: 'Markdown' },
    );
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
    const user = await requireLogin(ctx);
    if (!user) {
      resetState(userId);
      return ctx.answerCbQuery();
    }
    await ctx.answerCbQuery();
    try {
      await ctx.editMessageReplyMarkup(undefined);
    } catch {
      // best-effort cleanup
    }
    await ctx.reply(
      state.createSubIssue ? 'Creating sub-issue and logging…' : 'Logging…',
    );

    try {
      const gh = clientForUser(user);
      const project = await loadProject(gh);
      const dateField = findField(project.fields, FIELD_DATE);
      const minsField = findField(project.fields, FIELD_MINS);
      const remarksField = findField(project.fields, FIELD_REMARKS);
      const ownerField = findField(project.fields, FIELD_OWNER);

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
          `**Owner:** ${user.github_login}\n` +
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
      await gh.updateTextField(
        project.id,
        itemId,
        ownerField.id,
        user.github_login,
      );

      const viewer = await gh.getViewer();
      await gh.addAssignees(targetIssueId, [viewer.id]);

      if (state.createSubIssue) {
        await gh.closeIssue(targetIssueId, 'COMPLETED');
      }

      const link = `[#${targetIssueNumber} ${escapeMd(targetIssueTitle)}](${targetIssueUrl})`;
      const subLine = state.createSubIssue
        ? `\nSub-issue of [#${state.issue.number}](${state.issue.url}), closed.`
        : '';
      await ctx.reply(
        `Logged ${state.minutes}m on ${link}${subLine}\n` +
          `Date: ${state.date}\n` +
          `Remarks: ${state.remarks}\n` +
          `Owner: ${user.github_login}`,
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

    if (state.step === 'awaiting_pat') {
      const pat = text.trim();
      // Delete the user's PAT message immediately so it doesn't linger in chat history.
      try {
        await ctx.deleteMessage(ctx.message.message_id);
      } catch {
        // best-effort — bot may lack delete permission in groups
      }

      if (!pat) {
        return ctx.reply('PAT was empty. Run /login again.');
      }

      try {
        const tempClient = new GitHubClient(pat);
        const viewer = await tempClient.getViewer();
        setState(userId, {
          step: 'awaiting_login_confirm',
          pendingLogin: { token: pat, login: viewer.login },
        });
        await ctx.reply(
          `GitHub username found: *${escapeMd(viewer.login)}*. Is this you?`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: 'Yes', callback_data: 'login:yes' },
                  { text: 'No', callback_data: 'login:no' },
                ],
              ],
            },
          },
        );
      } catch (err: any) {
        resetState(userId);
        await ctx.reply(
          `Could not validate PAT: ${err?.message ?? String(err)}\nRun /login to try again.`,
        );
      }
      return;
    }

    // Everything below requires login.
    const user = await requireLogin(ctx);
    if (!user) return;

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
          const gh = clientForUser(user);
          const project = await loadProject(gh);
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
          `Owner: ${user.github_login}`;
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

  // Telegraf's launch() resolves only when the bot stops, so don't await it.
  bot.launch().catch((err) => console.error('Bot launch error:', err));
  console.log('Bot started.');

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

function escapeMd(s: string): string {
  return s.replace(/([\[\]()_*`])/g, '\\$1');
}
