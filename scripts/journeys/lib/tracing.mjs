// Keeping sign-in secrets out of Playwright traces. A trace records every action with its
// arguments, an evaluate's included. upload-results.mjs scrubs headers and auth bodies from a
// trace and checks it for secrets (lib/traces.mjs), but a refused upload loses the run's results,
// so the fixtures start tracing only after sign-in, mark the
// context here when they do, and every secret entry (secretFill, and signIn before it starts)
// refuses to run in a context that's being traced.

const traced = new WeakSet();

/** Records that tracing is on for a browser context. */
export function markTracing(context) {
  traced.add(context);
}

/** Throws if tracing is on for the context: a secret typed now would be in the trace. */
export function assertNotTracing(context, what = "a secret") {
  if (traced.has(context)) throw new Error(`Refusing to enter ${what} while this page is being traced: sign in before tracing starts, or in a new context`);
}

/**
 * Types a secret into an input without it reaching any report: Playwright names a fill() step
 * `Fill "<value>"`, and step titles and call logs can end up in the JSON report and the list
 * reporter's output. This sets the value in the page instead (the setter a framework watches,
 * then input and change events); an evaluate step's title and errors never carry its argument.
 * It refuses while the page's context is being traced, since a trace records the argument.
 */
export async function secretFill(locator, value) {
  assertNotTracing(locator.page().context());
  await locator.focus();
  await locator.evaluate((el, v) => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
    if (setter) setter.call(el, v);
    else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}
