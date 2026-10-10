import { afterEach, describe, expect, it, vi } from "vitest";
import { futureDate, futureOffsetMs, MAX_FUTURE_DAYS } from "./future-clock.js";

const DAY = 24 * 60 * 60 * 1000;

describe("FUTURE_DAYS", () => {
  it("is off when unset or empty", () => {
    expect(futureOffsetMs(undefined)).toBe(0);
    expect(futureOffsetMs("")).toBe(0);
  });

  it("takes whole days up to the maximum", () => {
    expect(futureOffsetMs("0")).toBe(0);
    expect(futureOffsetMs("60")).toBe(60 * DAY);
    expect(futureOffsetMs(String(MAX_FUTURE_DAYS))).toBe(MAX_FUTURE_DAYS * DAY);
  });

  it.each(["-1", "1.5", "sixty", " 60", "1e3", String(MAX_FUTURE_DAYS + 1)])("refuses %j loudly", (value) => {
    expect(() => futureOffsetMs(value)).toThrow(/FUTURE_DAYS must be a whole number/);
  });
});

describe("the moved Date", () => {
  afterEach(() => vi.useRealTimers());
  const RealDate = globalThis.Date;
  const offset = 60 * DAY;
  const Moved = futureDate(RealDate, offset);

  it("reads the clock ahead and leaves dates built from a value alone", () => {
    const before = RealDate.now();
    const now = Moved.now();
    const made = new Moved().getTime();
    expect(now - before).toBeGreaterThanOrEqual(offset);
    expect(now - before).toBeLessThan(offset + 5_000);
    expect(made - before).toBeGreaterThanOrEqual(offset);
    expect(new Moved(0).getTime()).toBe(0);
    expect(new Moved("2026-01-02T03:04:05Z").toISOString()).toBe("2026-01-02T03:04:05.000Z");
    expect(new Moved(2026, 0, 2).getFullYear()).toBe(2026);
    expect(Moved.UTC(2026, 0, 1)).toBe(RealDate.UTC(2026, 0, 1));
    expect(new Moved()).toBeInstanceOf(RealDate);
    expect(RealDate.parse((Moved as unknown as () => string)())).toBeGreaterThanOrEqual(Math.floor((before + offset) / 1000) * 1000);
  });

  it("is what fake timers start from, and what real timers put back", () => {
    const saved = globalThis.Date;
    globalThis.Date = Moved;
    try {
      const before = RealDate.now();
      vi.useFakeTimers();
      expect(Date.now() - before).toBeGreaterThanOrEqual(offset);
      vi.advanceTimersByTime(DAY);
      expect(Date.now() - before).toBeGreaterThanOrEqual(offset + DAY);
      vi.useRealTimers();
      expect(globalThis.Date).toBe(Moved);
    } finally {
      globalThis.Date = saved;
    }
  });
});

// Only in a FUTURE_DAYS run: proves the setup file moved this test's clock
describe.runIf(process.env.FUTURE_DAYS)("a FUTURE_DAYS run", () => {
  it("has the clock that many days ahead of the real one", () => {
    const real = performance.timeOrigin + performance.now();
    const ahead = Date.now() - real;
    expect(ahead).toBeGreaterThanOrEqual(futureOffsetMs(process.env.FUTURE_DAYS) - 5_000);
    expect(ahead).toBeLessThan(futureOffsetMs(process.env.FUTURE_DAYS) + 5_000);
  });
});
