// With FUTURE_DAYS set (npm run test:future, and the nightly CI run), every
// backend test runs with the clock that many days ahead, so a test that builds
// data on a fixed date but checks it against the real clock (a trial that ends
// 14 days after a fixed createdAt, #731) fails tonight, not on the day the
// real clock passes that date. Without it, this file does nothing.
//
// It moves Date only (Date.now(), new Date() and Date() with no arguments); a
// Date built from a value is unchanged, and timers and performance.now() run
// as usual. vi.useFakeTimers() starts its fake clock from the moved Date.now(),
// and vi.useRealTimers() puts the moved Date back, so tests with fake timers of
// their own keep working.
const raw = process.env.FUTURE_DAYS;

export const MAX_FUTURE_DAYS = 3650;

/** The offset in milliseconds for a FUTURE_DAYS value, or 0 when it's unset or empty. */
export function futureOffsetMs(value: string | undefined): number {
  if (value === undefined || value === "") return 0;
  if (!/^\d+$/.test(value) || Number(value) > MAX_FUTURE_DAYS) {
    throw new Error(`FUTURE_DAYS must be a whole number of days from 0 to ${MAX_FUTURE_DAYS}, not "${value}"`);
  }
  return Number(value) * 24 * 60 * 60 * 1000;
}

/** A Date that reads `offsetMs` ahead of `RealDate` whenever it reads the clock. */
export function futureDate(RealDate: DateConstructor, offsetMs: number): DateConstructor {
  const now = () => RealDate.now() + offsetMs;
  return new Proxy(RealDate, {
    construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [now()], newTarget),
    apply: () => new RealDate(now()).toString(),
    get: (target, prop, receiver) => (prop === "now" ? now : Reflect.get(target, prop, receiver)),
  });
}

const offset = futureOffsetMs(raw);
const marker = Symbol.for("supply-checkout.futureClock");
const g = globalThis as typeof globalThis & { [marker]?: true };
if (offset && !g[marker]) {
  g.Date = futureDate(Date, offset);
  g[marker] = true;
}
