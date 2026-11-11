/**
 * Observation ID coercion for get_observations and POST /api/observations/batch.
 *
 * MCP callers routinely pass IDs as strings such as "123" because search and
 * timeline print them as text. The worker route used to accept only numbers in
 * an array, so ["123"] failed with `expected number, received string`. Numeric
 * strings are now coerced to integers; everything else is left alone so the
 * validator rejects it with a message that names the offending value.
 */

const DECIMAL_INTEGER = /^-?\d+$/;

export const OBSERVATION_IDS_HINT = 'Pass numeric observation IDs from search or timeline, for example [123, 456].';

/** Split the string forms the batch route has always taken: a JSON array or a comma list. */
export function toObservationIdList(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // not JSON, fall through to comma split
  }
  return value.split(',').map((part) => part.trim()).filter(Boolean);
}

/** A numeric string becomes a number. Any other value is returned unchanged. */
export function coerceObservationId(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return DECIMAL_INTEGER.test(trimmed) ? Number(trimmed) : value;
}

/** List splitting plus per-element coercion. Non-list input is returned unchanged. */
export function coerceObservationIds(value: unknown): unknown {
  const list = toObservationIdList(value);
  return Array.isArray(list) ? list.map(coerceObservationId) : list;
}

function show(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return String(value);
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text;
}

/** One sentence naming the rejected value, shared by the worker route and the MCP wrapper. */
export function invalidObservationIdMessage(value: unknown): string {
  return `ids must be integers, got ${show(value)}. ${OBSERVATION_IDS_HINT}`;
}

export type ParsedObservationIds =
  | { ok: true; ids: number[] }
  | { ok: false; message: string };

/** Coerce and validate in one step. Used where no zod schema runs, such as the MCP wrapper. */
export function parseObservationIds(value: unknown): ParsedObservationIds {
  const list = coerceObservationIds(value);
  if (!Array.isArray(list)) {
    return { ok: false, message: `ids must be an array of integers, got ${show(value)}. ${OBSERVATION_IDS_HINT}` };
  }
  for (const id of list) {
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) {
      return { ok: false, message: invalidObservationIdMessage(id) };
    }
  }
  return { ok: true, ids: list as number[] };
}
