// Whole-number settings from the environment, failing closed. `Number('')` is 0 and `Number('2,880')` is
// NaN, and either silently changes what the gateway charges or switches a check off. Here unset or blank
// means the default; anything else must be plain digits, a safe integer, at least `min` (and at most
// `max`), or it is Setup required.
import { SetupRequiredError } from './scan.js';

export function intEnv(name: string, def: number, o: { min?: number; max?: number } = {}, env: Record<string, string | undefined> = process.env): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const min = o.min ?? 0;
  const n = /^\d{1,16}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || (o.max !== undefined && n > o.max))
    throw new SetupRequiredError(name, `a whole number ${o.max !== undefined ? `from ${min} to ${o.max}` : `of at least ${min}`}, got ${JSON.stringify(raw.slice(0, 24))}`);
  return n;
}

/** A setting that must be a non-negative whole number when given in code (not from the environment). */
export function wholeNumber(name: string, v: number): number {
  if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`${name} must be a non-negative whole number, got ${v}`);
  return v;
}
