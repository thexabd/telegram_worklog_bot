export function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseDate(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === 'today') return formatDate(new Date());
  if (trimmed === 'yesterday') {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return formatDate(d);
  }
  const m = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const [, y, mo, da] = m;
  const d = new Date(Number(y), Number(mo) - 1, Number(da));
  if (Number.isNaN(d.getTime())) return null;
  if (
    d.getFullYear() !== Number(y) ||
    d.getMonth() !== Number(mo) - 1 ||
    d.getDate() !== Number(da)
  ) {
    return null;
  }
  return formatDate(d);
}

export function getWeekRange(today: Date = new Date()): {
  start: string;
  end: string;
} {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  // ISO week: Monday = 0, Sunday = 6
  const offset = (d.getDay() + 6) % 7;
  const start = new Date(d);
  start.setDate(d.getDate() - offset);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return { start: formatDate(start), end: formatDate(end) };
}

export function getMonthRange(today: Date = new Date()): {
  start: string;
  end: string;
} {
  const start = new Date(today.getFullYear(), today.getMonth(), 1);
  const end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  return { start: formatDate(start), end: formatDate(end) };
}

export function formatMinutes(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

export function weekdayShort(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getDay()];
}

export interface IssueInputRef {
  owner: string;
  repo: string;
  number: number;
}

export function parseIssueInput(
  input: string,
  defaultOwner?: string,
  defaultRepo?: string,
): IssueInputRef | null {
  const trimmed = input.trim();

  // Full URL: https://github.com/{owner}/{repo}/issues/{n}
  const urlMatch = trimmed.match(
    /github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)/i,
  );
  if (urlMatch) {
    return {
      owner: urlMatch[1],
      repo: urlMatch[2],
      number: Number(urlMatch[3]),
    };
  }

  // owner/repo#123 or owner/repo/123 or owner/repo 123
  const fullMatch = trimmed.match(
    /^([\w.-]+)\/([\w.-]+)\s*[#/ ]\s*(\d+)$/,
  );
  if (fullMatch) {
    return {
      owner: fullMatch[1],
      repo: fullMatch[2],
      number: Number(fullMatch[3]),
    };
  }

  // repo#123 or repo/123 or repo 123 (uses defaultOwner)
  if (defaultOwner) {
    const repoNum = trimmed.match(/^([\w.-]+)\s*[#/ ]\s*(\d+)$/);
    if (repoNum) {
      return {
        owner: defaultOwner,
        repo: repoNum[1],
        number: Number(repoNum[2]),
      };
    }
  }

  // Bare #123 or 123 (needs both defaults)
  const numMatch = trimmed.match(/^#?(\d+)$/);
  if (numMatch && defaultOwner && defaultRepo) {
    return {
      owner: defaultOwner,
      repo: defaultRepo,
      number: Number(numMatch[1]),
    };
  }

  return null;
}
