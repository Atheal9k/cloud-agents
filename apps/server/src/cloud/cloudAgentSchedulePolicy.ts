import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

type ParsedField = {
  readonly values: ReadonlySet<number>;
  readonly wildcard: boolean;
};

export type ParsedCron = {
  readonly minutes: ParsedField;
  readonly hours: ParsedField;
  readonly days: ParsedField;
  readonly months: ParsedField;
  readonly weekdays: ParsedField;
};

export type CronParseResult =
  | { readonly ok: true; readonly cron: ParsedCron }
  | { readonly ok: false; readonly message: string };

function parseNumber(value: string, min: number, max: number): number | undefined {
  if (!/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : undefined;
}

function parseField(input: {
  readonly text: string;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly normalize?: (value: number) => number;
}): ParsedField | string {
  const values = new Set<number>();
  for (const segment of input.text.split(",")) {
    const [rangeText, stepText, extra] = segment.split("/");
    if (rangeText === undefined || extra !== undefined) {
      return `${input.label} contains an invalid step.`;
    }
    const step = stepText === undefined ? 1 : parseNumber(stepText, 1, input.max - input.min + 1);
    if (step === undefined) return `${input.label} has an invalid step.`;
    let start: number;
    let end: number;
    if (rangeText === "*") {
      start = input.min;
      end = input.max;
    } else {
      const [startText, endText, rangeExtra] = rangeText.split("-");
      if (startText === undefined || rangeExtra !== undefined) {
        return `${input.label} contains an invalid range.`;
      }
      const parsedStart = parseNumber(startText, input.min, input.max);
      const parsedEnd =
        endText === undefined ? parsedStart : parseNumber(endText, input.min, input.max);
      if (parsedStart === undefined || parsedEnd === undefined || parsedEnd < parsedStart) {
        return `${input.label} contains an invalid range.`;
      }
      start = parsedStart;
      end = parsedEnd;
    }
    for (let value = start; value <= end; value += step) {
      values.add(input.normalize?.(value) ?? value);
    }
  }
  return { values, wildcard: input.text.startsWith("*") };
}

export function parseCloudAgentCron(expression: string): CronParseResult {
  const [minuteText, hourText, dayText, monthText, weekdayText, extra] = expression
    .trim()
    .split(/\s+/u);
  if (
    minuteText === undefined ||
    hourText === undefined ||
    dayText === undefined ||
    monthText === undefined ||
    weekdayText === undefined ||
    extra !== undefined
  ) {
    return { ok: false, message: "Cron must have five fields: minute hour day month weekday." };
  }
  const minutes = parseField({ text: minuteText, label: "minute", min: 0, max: 59 });
  if (typeof minutes === "string") return { ok: false, message: minutes };
  const hours = parseField({ text: hourText, label: "hour", min: 0, max: 23 });
  if (typeof hours === "string") return { ok: false, message: hours };
  const days = parseField({ text: dayText, label: "day", min: 1, max: 31 });
  if (typeof days === "string") return { ok: false, message: days };
  const months = parseField({ text: monthText, label: "month", min: 1, max: 12 });
  if (typeof months === "string") return { ok: false, message: months };
  const weekdays = parseField({
    text: weekdayText,
    label: "weekday",
    min: 0,
    max: 7,
    normalize: (value) => (value === 7 ? 0 : value),
  });
  if (typeof weekdays === "string") return { ok: false, message: weekdays };
  return { ok: true, cron: { minutes, hours, days, months, weekdays } };
}

function dateMatches(
  cron: ParsedCron,
  date: Pick<DateTime.DateTime.PartsWithWeekday, "day" | "month" | "weekDay">,
): boolean {
  if (!cron.months.values.has(date.month)) return false;
  const dayMatch = cron.days.values.has(date.day);
  const weekdayMatch = cron.weekdays.values.has(date.weekDay);
  if (cron.days.wildcard && cron.weekdays.wildcard) return true;
  if (cron.days.wildcard) return weekdayMatch;
  if (cron.weekdays.wildcard) return dayMatch;
  return dayMatch || weekdayMatch;
}

function sorted(values: ReadonlySet<number>): ReadonlyArray<number> {
  return [...values].sort((left, right) => left - right);
}

/**
 * Returns the next matching instant. Missing DST wall times are skipped and a
 * repeated wall time uses its earlier occurrence, so one cron slot runs once.
 */
export function nextCloudAgentScheduleAt(input: {
  readonly cron: ParsedCron;
  readonly timezone: string;
  readonly afterMs: number;
}): string | undefined {
  const zone = Option.getOrUndefined(DateTime.zoneMakeNamed(input.timezone));
  if (zone === undefined) return undefined;
  const start = DateTime.toParts(DateTime.makeZonedUnsafe(input.afterMs, { timeZone: zone }));
  const firstDay = Date.UTC(start.year, start.month - 1, start.day);
  const hours = sorted(input.cron.hours.values);
  const minutes = sorted(input.cron.minutes.values);
  const maxDays = 366 * 5;
  for (let offset = 0; offset <= maxDays; offset += 1) {
    const date = DateTime.toPartsUtc(DateTime.makeUnsafe(firstDay + offset * 24 * 60 * 60 * 1_000));
    if (!dateMatches(input.cron, date)) continue;
    const { year, month, day } = date;
    for (const hour of hours) {
      for (const minute of minutes) {
        const candidate = Option.getOrUndefined(
          DateTime.makeZoned(
            { year, month, day, hour, minute, second: 0, millisecond: 0 },
            { timeZone: zone, adjustForTimeZone: true, disambiguation: "earlier" },
          ),
        );
        if (candidate === undefined) continue;
        const parts = DateTime.toParts(candidate);
        if (
          parts.year !== year ||
          parts.month !== month ||
          parts.day !== day ||
          parts.hour !== hour ||
          parts.minute !== minute
        ) {
          continue;
        }
        const candidateMs = DateTime.toEpochMillis(candidate);
        if (candidateMs > input.afterMs) return DateTime.formatIso(candidate);
      }
    }
  }
}

export function validateCloudAgentScheduleTiming(input: {
  readonly cron: string;
  readonly timezone: string;
}): { readonly cron: ParsedCron } | { readonly message: string } {
  const parsed = parseCloudAgentCron(input.cron);
  if (!parsed.ok) return { message: parsed.message };
  if (Option.isNone(DateTime.zoneMakeNamed(input.timezone))) {
    return { message: `Timezone '${input.timezone}' is not a valid IANA timezone.` };
  }
  return { cron: parsed.cron };
}
