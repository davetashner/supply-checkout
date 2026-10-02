// The operator page (supply-checkout-gxlt, ADR 0015 §6), served on its own origin,
// ops.<env domain>, with no customer app code. It signs in through the operator pool and calls
// only the /ops routes (lib/api.js), the same ones as `npm run ops`.
//
// Rules this file keeps:
// - API data is only ever put in the page as text (textContent, via h()), never as HTML. The
//   CloudFront CSP also requires Trusted Types, so an HTML sink would throw.
// - The access token is only in `session` below: no storage, no cookies, no console, no logs.
// - Every write needs a reason, and sends the team's version and an Idempotency-Key.
import { ApiError, NetworkError, TEAM_ID, createApi } from "./lib/api.js";
import { SignInError, beginSignIn, callbackParams, exchangeCode, logoutUrl, sessionFor, takePending, withoutCallback } from "./lib/auth.js";
import { ConfigError, loadConfig } from "./lib/config.js";
import {
  DISCOUNT_OUTCOMES,
  InputError,
  MAX_COMP_MONTHS,
  auditRow,
  checkMonth,
  compBody,
  date,
  endCompBody,
  idempotencyKeys,
  receiptLines,
  stripeFacts,
  teamFacts,
  teamRow,
} from "./lib/format.js";

const main = document.getElementById("main");
const account = document.getElementById("account");

let config = null;
let api = null;
/** { token, expiresAt, username } while signed in; only ever here. */
let session = null;
let expiryTimer = null;
let clockTimer = null;
/** The last team list, kept in memory so going back doesn't search again. */
let teamsView = { q: "", teams: [], cursor: undefined, loaded: false };
/** What the operator typed in a team's forms, kept across "read it again". */
let drafts = {};
const keys = idempotencyKeys();

/** An element with text children only. Attributes never take API data as markup or handlers. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (/^on/i.test(name)) throw new Error("No inline handlers");
    if (name === "href" && !/^#\/[A-Za-z0-9/_-]*$/.test(String(value))) throw new Error("Only in-page links");
    if (name === "className") el.className = value;
    else if (name === "value") el.value = value;
    else if (name === "checked") el.checked = !!value;
    else el.setAttribute(name, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function show(...nodes) {
  main.replaceChildren(...nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));
  const heading = main.querySelector("h1, h2");
  if (heading) {
    heading.setAttribute("tabindex", "-1");
    heading.focus({ preventScroll: true });
  }
}

const message = (kind, ...lines) => h("div", { className: `notice ${kind}`, role: kind === "error" || kind === "conflict" ? "alert" : "status" }, ...lines.map((l) => (l instanceof Node ? l : h("p", {}, l))));

// Sign-in and the session

function minutesLeft() {
  return Math.max(0, Math.ceil((session.expiresAt - Date.now()) / 60_000));
}

function drawAccount() {
  if (!session) {
    account.replaceChildren();
    return;
  }
  const signOutButton = h("button", { type: "button", className: "secondary" }, "Sign out");
  signOutButton.addEventListener("click", signOut);
  account.replaceChildren(
    h("nav", { "aria-label": "Operator pages" }, h("a", { href: "#/teams" }, "Teams"), h("a", { href: "#/audit" }, "Audit")),
    h("span", { className: "who" }, `Signed in as ${session.username || "operator"}`),
    h("span", { className: "clock", id: "clock" }, `Session ends in ${minutesLeft()} min`),
    signOutButton,
  );
}

function forget() {
  session = null;
  clearTimeout(expiryTimer);
  clearInterval(clockTimer);
  teamsView = { q: "", teams: [], cursor: undefined, loaded: false };
  drafts = {};
  drawAccount();
}

/** Back to the sign-in screen, forgetting the token and everything read with it. */
function signedOut(note) {
  forget();
  const button = h("button", { type: "button" }, "Sign in");
  button.addEventListener("click", () => signIn().catch(() => show(signInScreen("Couldn't start the sign-in. Reload the page and try again."))));
  show(signInScreen(note, button));
}

function signInScreen(note, button) {
  return h(
    "section",
    { className: "signin" },
    h("h1", {}, "Supply Checkout operations"),
    h("p", {}, "Sign in with your operator account: username, password, then the code from your authenticator app."),
    note ? message("error", note) : null,
    button ?? null,
  );
}

async function signIn() {
  const url = await beginSignIn(config, { storage: sessionStorage, returnTo: location.hash });
  location.assign(url);
}

function signOut() {
  forget();
  main.replaceChildren(message("info", "Signing out…"));
  location.assign(logoutUrl(config));
}

function startSession(next) {
  session = next;
  clearTimeout(expiryTimer);
  clearInterval(clockTimer);
  // The token expires in 15 minutes and there's no refresh: sign in again then
  expiryTimer = setTimeout(() => signedOut("Your 15-minute session ended. Sign in again."), Math.max(0, session.expiresAt - Date.now()));
  clockTimer = setInterval(() => {
    const clock = document.getElementById("clock");
    if (clock && session) clock.textContent = `Session ends in ${minutesLeft()} min`;
  }, 30_000);
  drawAccount();
}

const currentToken = () => (session && session.expiresAt > Date.now() ? session.token : undefined);

// Errors from the API, as the operator should see them

function problem(error) {
  if (error instanceof ApiError && error.status === 401) return null; // signedOut() already took over
  if (error instanceof ApiError && error.status === 403) return message("error", "This account isn't an operator (or no longer is). Ask an administrator.");
  if (error instanceof ApiError && error.status === 404) return message("error", error.message || "Not found");
  if (error instanceof ApiError && error.status === 429) return message("error", "Too many requests just now. Wait a few seconds and try again.");
  if (error instanceof ApiError) return message("error", error.message);
  if (error instanceof NetworkError || error instanceof InputError) return message("error", error.message);
  return message("error", "Something went wrong. Try again.");
}

// Teams

async function drawTeams({ search } = {}) {
  const form = h("form", { className: "search", role: "search" });
  const input = h("input", { id: "q", name: "q", type: "search", value: teamsView.q, autocomplete: "off", maxlength: "128" });
  form.append(h("label", { for: "q" }, "Team name or ID"), input, h("button", { type: "submit" }, "Search"));
  const results = h("div", { id: "results" });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    teamsView = { q: input.value.trim(), teams: [], cursor: undefined, loaded: false };
    load();
  });
  show(h("h1", {}, "Teams"), form, results);

  async function load(cursor) {
    results.setAttribute("aria-busy", "true");
    try {
      const page = await api.listTeams({ q: teamsView.q, cursor });
      teamsView.teams = cursor ? [...teamsView.teams, ...page.teams] : page.teams;
      teamsView.cursor = page.cursor;
      teamsView.loaded = true;
      drawResults();
    } catch (error) {
      results.replaceChildren(problem(error) ?? "");
    } finally {
      results.removeAttribute("aria-busy");
    }
  }

  function drawResults() {
    const now = Date.now();
    const rows = teamsView.teams.map((team) => {
      const row = teamRow(team, now);
      const name = TEAM_ID.test(String(team.id)) ? h("a", { href: `#/team/${team.id}` }, row.name) : row.name;
      return h("tr", {}, h("td", {}, name), h("td", { className: "mono" }, row.id), h("td", {}, row.plan), h("td", {}, row.comp), h("td", {}, row.owners), h("td", {}, row.created));
    });
    const more = h("button", { type: "button", className: "secondary" }, "More");
    more.addEventListener("click", () => load(teamsView.cursor));
    results.replaceChildren(
      rows.length
        ? h("table", {}, h("thead", {}, h("tr", {}, ["Name", "ID", "Plan / status", "Comp", "Owners", "Created"].map((c) => h("th", { scope: "col" }, c)))), h("tbody", {}, rows))
        : h("p", {}, teamsView.cursor ? "No teams yet (the search isn't finished: press More)." : "No teams."),
      teamsView.cursor ? more : "",
    );
  }

  if (search || !teamsView.loaded) await load();
  else drawResults();
}

// One team

function field(id, label, control, hint) {
  if (hint) control.setAttribute("aria-describedby", `${id}-hint`);
  return h("div", { className: "field" }, h("label", { for: id }, label), control, hint ? h("p", { className: "hint", id: `${id}-hint` }, hint) : null);
}

function draftInput(form, key, props) {
  const input = h("input", { ...props, value: drafts[`${form}.${key}`] ?? props.value });
  input.addEventListener("input", () => (drafts[`${form}.${key}`] = input.value));
  return input;
}

async function drawTeam(teamId) {
  show(h("p", { "aria-busy": "true" }, "Loading the team…"));
  let detail;
  try {
    detail = await api.getTeam(teamId);
  } catch (error) {
    const box = problem(error);
    if (box) show(h("h1", {}, "Team"), box, h("p", {}, h("a", { href: "#/teams" }, "Back to teams")));
    return;
  }
  const { team, stripe, receipts } = detail;
  const now = Date.now();
  const outcome = h("div", { id: "outcome", "aria-live": "polite" });
  const stripeView = stripeFacts(stripe);
  const invoices = stripeView.invoices.length
    ? h("table", {}, h("caption", {}, "Latest invoices"), h("thead", {}, h("tr", {}, ["Number", "Status", "Total", "Date"].map((c) => h("th", { scope: "col" }, c)))), h("tbody", {}, stripeView.invoices.map((i) => h("tr", {}, h("td", { className: "mono" }, i.number), h("td", {}, i.status), h("td", {}, i.total), h("td", {}, i.created)))))
    : stripe && !stripe.error ? h("p", {}, "No invoices") : null;

  show(
    h("p", {}, h("a", { href: "#/teams" }, "Back to teams")),
    h("h1", {}, String(team.name ?? "Team")),
    h("dl", { className: "facts" }, teamFacts(team, now).map(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])),
    Array.isArray(team.owners) && team.owners.length
      ? h("section", {}, h("h2", {}, "Owners"), h("ul", {}, team.owners.map((o) => h("li", {}, `${o?.email ?? "(no email)"} (${o?.userId ?? "?"}), joined ${date(o?.joinedAt)}`))))
      : null,
    h("section", {}, h("h2", {}, "Billing"), h("p", {}, stripeView.summary), stripeView.discount ? h("p", { id: "discount" }, stripeView.discount) : null, stripeView.notes.map((n) => h("p", {}, n)), invoices),
    receiptLines(receipts).length ? h("section", {}, h("h2", {}, "Receipt reads"), h("ul", {}, receiptLines(receipts).map((l) => h("li", {}, l)))) : null,
    outcome,
    team.closedAt ? h("p", {}, "A closed team can't be comped. Reopen it with npm run ops -- reopen first.") : [compForm(team, outcome), team.comp ? endCompForm(team, outcome) : null],
    h("p", {}, h("a", { href: `#/audit/${team.id}` }, "This team's operator audit")),
  );
}

function compForm(team, outcome) {
  const id = (s) => `comp-${s}`;
  const mode = drafts["comp.mode"] ?? "months";
  const months = h("select", { id: id("months"), name: "months" }, Array.from({ length: MAX_COMP_MONTHS }, (_, i) => h("option", { value: String(i + 1) }, `${i + 1} month${i ? "s" : ""}`)));
  months.value = drafts["comp.months"] ?? "1";
  months.addEventListener("change", () => (drafts["comp.months"] = months.value));
  const radio = (value, label) => {
    const input = h("input", { type: "radio", name: "mode", value, id: id(`mode-${value}`), checked: mode === value });
    input.addEventListener("change", () => (drafts["comp.mode"] = value));
    return h("label", { for: id(`mode-${value}`), className: "choice" }, input, ` ${label}`);
  };
  const until = draftInput("comp", "until", { id: id("until"), name: "until", type: "date" });
  const plan = draftInput("comp", "plan", { id: id("plan"), name: "plan", type: "text", value: team.plan, autocomplete: "off", maxlength: "32" });
  const seats = draftInput("comp", "seats", { id: id("seats"), name: "seats", type: "number", min: "1", max: "100", step: "1", inputmode: "numeric" });
  const reason = draftInput("comp", "reason", { id: id("reason"), name: "reason", type: "text", required: true, minlength: "3", maxlength: "500", autocomplete: "off" });
  const submit = h("button", { type: "submit" }, "Comp team");
  const form = h(
    "form",
    { className: "write", "aria-labelledby": id("heading"), novalidate: true },
    h("h2", { id: id("heading") }, team.comp?.live ? "Change or extend the comp" : "Comp this team"),
    h("fieldset", {}, h("legend", {}, "How long"), radio("months", "For a number of months"), radio("until", "Until a date")),
    field(id("months"), "Months", months, "A team paying monthly through Stripe also gets $0 invoices for these months, then billing resumes by itself."),
    field(id("until"), "Until (UTC, at most 12 months ahead)", until, "No Stripe discount: a comp with an end date changes access in the app only."),
    field(id("plan"), "Plan", plan),
    field(id("seats"), "Seats (optional)", seats),
    field(id("reason"), "Reason (required, shown to the team's owners as support activity)", reason),
    submit,
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = { mode: form.elements.mode.value, months: months.value, until: until.value, plan: plan.value, seats: seats.value, reason: reason.value };
    let body;
    try {
      body = compBody(values, team);
    } catch (error) {
      outcome.replaceChildren(problem(error));
      return;
    }
    await write(submit, outcome, team, () => api.setComp(team.id, body, keys.keyFor(["comp", team.id, body])), (o) => [
      o.comp ? `Comped ${team.name}: ${o.comp.plan} until ${date(o.comp.until)}${o.months ? ` (${o.months} months)` : ""}. Audit event ${o.eventId}.` : `Saved. Audit event ${o.eventId}.`,
      DISCOUNT_OUTCOMES[o.stripeDiscount],
    ]);
  });
  return form;
}

function endCompForm(team, outcome) {
  const reason = draftInput("end", "reason", { id: "end-reason", name: "reason", type: "text", required: true, minlength: "3", maxlength: "500", autocomplete: "off" });
  const submit = h("button", { type: "submit", className: "danger" }, "End comp now");
  const form = h(
    "form",
    { className: "write", "aria-labelledby": "end-heading", novalidate: true },
    h("h2", { id: "end-heading" }, "End the comp"),
    h("p", {}, "Ends it now, and takes off any Stripe discount it gave."),
    field("end-reason", "Reason (required)", reason),
    submit,
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    let body;
    try {
      body = endCompBody({ reason: reason.value }, team);
    } catch (error) {
      outcome.replaceChildren(problem(error));
      return;
    }
    await write(submit, outcome, team, () => api.endComp(team.id, body, keys.keyFor(["uncomp", team.id, body])), (o) => [`Ended the comp of ${team.name}. Audit event ${o.eventId}.`, DISCOUNT_OUTCOMES[o.stripeDiscount]]);
  });
  return form;
}

/** Sends a write, then reads the team again on success. A 409 says to read it again first. */
async function write(button, outcome, team, send, describe) {
  button.disabled = true;
  outcome.replaceChildren(message("info", "Saving…"));
  try {
    const answer = await send();
    keys.answered();
    drafts = {};
    await drawTeam(team.id);
    document.getElementById("outcome")?.replaceChildren(message("success", ...describe(answer).filter(Boolean)));
  } catch (error) {
    button.disabled = false;
    if (!(error instanceof NetworkError)) keys.answered();
    if (error instanceof ApiError && error.status === 409) {
      const again = h("button", { type: "button" }, "Read the team again");
      again.addEventListener("click", () => drawTeam(team.id));
      outcome.replaceChildren(
        message(
          "conflict",
          h("p", {}, h("strong", {}, "Not saved. "), error.message),
          "The team changed since you opened it (another operator, the team's owners or billing), or it can't take this change now. Read it again, check what it says now, then send the change again.",
          again,
        ),
      );
      return;
    }
    const box = problem(error);
    if (box && error instanceof NetworkError) box.append(h("p", {}, "Sending again sends the same request, which is applied at most once."));
    outcome.replaceChildren(box ?? "");
  }
}

// The audit

async function drawAudit(teamId) {
  const thisMonth = new Date().toISOString().slice(0, 7);
  const teamInput = h("input", { id: "audit-team", name: "team", type: "text", value: teamId ?? "", autocomplete: "off", maxlength: "128" });
  const monthInput = h("input", { id: "audit-month", name: "month", type: "text", value: teamId ? "" : thisMonth, placeholder: "YYYY-MM", inputmode: "numeric", maxlength: "7" });
  const form = h(
    "form",
    { className: "search" },
    field("audit-team", "Team ID", teamInput, "One team's audit, including the billing worker's Stripe discount changes"),
    field("audit-month", "Or month", monthInput, "Every operator action that month"),
    h("button", { type: "submit" }, "Show"),
  );
  const results = h("div", { id: "results" });
  let events = [];
  let query = {};
  show(h("h1", {}, "Operator audit"), form, results);

  async function load(cursor) {
    try {
      const page = await api.audit({ ...query, cursor });
      events = cursor ? [...events, ...page.events] : page.events;
      const more = h("button", { type: "button", className: "secondary" }, "More");
      more.addEventListener("click", () => load(page.cursor));
      results.replaceChildren(
        events.length
          ? h(
              "table",
              {},
              h("thead", {}, h("tr", {}, ["Time", "Action", "Team", "By", "Change", "Reason"].map((c) => h("th", { scope: "col" }, c)))),
              h(
                "tbody",
                {},
                events.map((e) => {
                  const row = auditRow(e);
                  const team = TEAM_ID.test(String(e.teamId)) ? h("a", { href: `#/team/${e.teamId}` }, row.teamId) : row.teamId;
                  return h("tr", {}, h("td", { className: "mono" }, row.ts), h("td", {}, row.action), h("td", { className: "mono" }, team), h("td", { className: "mono" }, row.by), h("td", {}, row.change), h("td", {}, row.reason));
                }),
              ),
            )
          : h("p", {}, "No operator actions."),
        page.cursor ? more : "",
      );
    } catch (error) {
      results.replaceChildren(problem(error) ?? "");
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const team = teamInput.value.trim();
      const month = checkMonth(monthInput.value);
      if (team && month) throw new InputError("Give a team ID or a month, not both");
      if (team && !TEAM_ID.test(team)) throw new InputError("That isn't a team ID");
      query = team ? { teamId: team } : { month: month ?? thisMonth };
    } catch (error) {
      results.replaceChildren(problem(error));
      return;
    }
    load();
  });
  query = teamId ? { teamId } : { month: thisMonth };
  await load();
}

// Routing: #/teams, #/team/<id>, #/audit, #/audit/<teamId>

async function route() {
  if (!session) return;
  const [, view, id] = location.hash.split("/");
  if (view === "team" && id && TEAM_ID.test(id)) return drawTeam(id);
  if (view === "audit") return drawAudit(id && TEAM_ID.test(id) ? id : undefined);
  return drawTeams();
}

async function start() {
  try {
    config = await loadConfig(fetch, location);
  } catch (error) {
    show(h("h1", {}, "Supply Checkout operations"), message("error", error instanceof ConfigError ? error.message : "Couldn't load the page's config."));
    return;
  }
  api = createApi({ apiUrl: config.apiUrl, getToken: currentToken, onUnauthorized: () => signedOut("Your session ended or was signed out. Sign in again."), fetchFn: (...args) => fetch(...args) });
  window.addEventListener("hashchange", () => route());

  const answer = callbackParams(location.href);
  if (answer) {
    // The code and state leave the address bar (and history) before anything else happens
    history.replaceState(null, "", withoutCallback(location.href));
    try {
      const pending = takePending(sessionStorage, answer);
      startSession(sessionFor(await exchangeCode(config, pending, fetch), config));
      if (pending.returnTo && pending.returnTo !== location.hash) {
        location.hash = pending.returnTo;
        return;
      }
    } catch (error) {
      signedOut(error instanceof SignInError ? error.message : "Sign-in failed. Sign in again.");
      return;
    }
  }
  if (!session) {
    signedOut();
    return;
  }
  await route();
}

start();
