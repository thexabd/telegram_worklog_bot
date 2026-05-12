export type FlowStep =
  | 'idle'
  | 'awaiting_issue'
  | 'awaiting_subissue_choice'
  | 'awaiting_date'
  | 'awaiting_minutes'
  | 'awaiting_remarks'
  | 'awaiting_confirmation';

export interface IssueRef {
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  nodeId: string;
  repoId: string;
  projectItemId: string;
}

export interface ConversationState {
  step: FlowStep;
  selectedRepo?: string;
  issue?: IssueRef;
  createSubIssue?: boolean;
  date?: string;
  minutes?: number;
  remarks?: string;
}

const states = new Map<number, ConversationState>();

interface UserPrefs {
  recentRepos: string[];
}

const RECENT_REPO_LIMIT = 5;
const prefs = new Map<number, UserPrefs>();

export function getRecentRepos(userId: number): string[] {
  return prefs.get(userId)?.recentRepos ?? [];
}

export function rememberRepo(userId: number, repo: string): void {
  const current = getRecentRepos(userId);
  const next = [repo, ...current.filter((r) => r !== repo)].slice(
    0,
    RECENT_REPO_LIMIT,
  );
  prefs.set(userId, { recentRepos: next });
}

export function getState(userId: number): ConversationState {
  let s = states.get(userId);
  if (!s) {
    s = { step: 'idle' };
    states.set(userId, s);
  }
  return s;
}

export function resetState(userId: number): void {
  states.set(userId, { step: 'idle' });
}

export function setState(
  userId: number,
  patch: Partial<ConversationState>,
): ConversationState {
  const next = { ...getState(userId), ...patch };
  states.set(userId, next);
  return next;
}
