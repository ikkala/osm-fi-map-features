// When a building was built, as OSM's start_date tells it, kept as tagged: a year ("1897", "1897-05-01"), a decade
// ("1890s"), a century ("C19", "early C19", "mid C19", "late C19"), a span ("1904..1920"), "before 1900" or
// "after 1900". Rules ask it what it tells (built before a year?) and get no answer where it cannot tell.

/** What is known of when a building was built: its year, else its start_date as tagged */
export interface Built {
  year?: number;
  startDate?: string;
}

/** The earliest and the latest year a start_date allows, or undefined for one it does not read ("~1897") */
function bounds(value: string): [number, number] | undefined {
  const date = value.trim();
  const year = /^(\d{4})(?:-\d\d(?:-\d\d)?)?$/.exec(date);
  if (year) {
    return [Number(year[1]), Number(year[1])];
  }
  const decade = /^(\d{3})0s$/.exec(date);
  if (decade) {
    return [Number(decade[1]) * 10, Number(decade[1]) * 10 + 9];
  }
  // a century's years are counted both from 1 and from 0 ("C19": 1801-1900 or 1800-1899): it allows either
  const century = /^(?:(early|mid|late) )?C(\d{1,2})$/.exec(date);
  if (century) {
    const first = (Number(century[2]) - 1) * 100;
    const third = { early: [0, 34], mid: [33, 67], late: [66, 100] }[century[1] ?? ""] ?? [0, 100];
    return [first + third[0], first + third[1]];
  }
  const span = /^(\S+)\.\.(\S+)$/.exec(date);
  if (span) {
    const from = bounds(span[1]);
    const to = bounds(span[2]);
    return from && to ? [from[0], to[1]] : undefined;
  }
  const before = /^before (\S+)$/.exec(date);
  if (before) {
    const until = bounds(before[1]);
    return until ? [-Infinity, until[0] - 1] : undefined;
  }
  const after = /^after (\S+)$/.exec(date);
  if (after) {
    const since = bounds(after[1]);
    return since ? [since[1] + 1, Infinity] : undefined;
  }
  return undefined;
}

/** The year a start_date names, when it names one */
export function exactYear(startDate: string | undefined): number | undefined {
  const b = startDate === undefined ? undefined : bounds(startDate);
  return b && b[0] === b[1] ? b[0] : undefined;
}

/** Whether a start_date allows the year */
export function allows(startDate: string, year: number): boolean {
  const b = bounds(startDate);
  return !b || (year >= b[0] && year <= b[1]);
}

/** Whether it was built before the year: true or false when what is known tells, else undefined */
export function builtBefore(built: Built, year: number): boolean | undefined {
  if (built.year !== undefined) {
    return built.year < year;
  }
  const b = built.startDate === undefined ? undefined : bounds(built.startDate);
  if (!b) {
    return undefined;
  }
  return b[1] < year ? true : b[0] >= year ? false : undefined;
}

/**
 * Of eras ordered by the year before which each ends, the one it was built in, or undefined when what is known
 * does not tell which: before an era's end, and not before the previous one's.
 */
export function eraOf<T extends { before: number }>(built: Built, eras: readonly T[]): T | undefined {
  for (const era of eras) {
    // the earlier eras are known not to be it
    const inIt = builtBefore(built, era.before);
    if (inIt !== false) {
      return inIt ? era : undefined;
    }
  }
  return undefined;
}
