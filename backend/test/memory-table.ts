// An in-memory stand-in for the app table, for handler tests that run without
// DynamoDB Local. It understands only the commands and expressions the
// document functions and authorizeTeam send. Each Db it hands out can be
// scoped to one team, the way the data-access role's dynamodb:LeadingKeys
// condition scopes a role session: a call that names any other partition is
// refused with AccessDeniedException.

import { convertToAttr, convertToNative } from "@aws-sdk/util-dynamodb";
import type { Db } from "../src/data/index.js";
import { GSI3, OPS_INDEX_ATTRIBUTES } from "../src/data/schema.js";
import { fakeDb, REGION } from "./helpers.js";

/** Indexes that don't project every attribute, and what they do project besides the keys (data-stack.ts). */
const PROJECTIONS: Record<string, readonly string[]> = { [GSI3]: OPS_INDEX_ATTRIBUTES };

type Item = Record<string, unknown>;
type Input = Record<string, unknown> & {
  Key?: Item;
  Item?: Item;
  ConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
};

export interface Call {
  readonly command: string;
  /** The partition keys the call named (PK, or GSI1PK for an index query). */
  readonly partitions: string[];
}

export class MemoryTable {
  readonly items = new Map<string, Item>();
  readonly calls: Call[] = [];
  /** Each request as DynamoDB would get it, in the same order as `calls`. */
  readonly requests: { readonly command: string; readonly input: Record<string, unknown> }[] = [];
  /** Runs after each GetCommand, before its result returns: a concurrent writer. */
  afterGet?: (item: Item | undefined) => void;
  /** Runs before each TransactWriteCommand is applied: a concurrent writer. */
  beforeTransactWrite?: () => void;
  /** Runs before each PutCommand is applied, after its condition passes: DynamoDB refusing it, say. */
  beforePut?: (item: Item) => void;

  private static id = (k: Item) => `${String(k.PK)}\u0000${String(k.SK)}`;

  /** DynamoDB's limit on one transaction's size. A test can lower it. */
  maxTransactionBytes = 4_000_000;

  /** The number of items in each transaction that got past the size check, in order. */
  readonly transactions: number[] = [];

  /** DynamoDB's item size limit. The table measures an item as JSON, which is close enough. */
  static readonly MAX_ITEM_BYTES = 400_000;

  /**
   * A value's size as JSON, as DynamoDB gets it: a map with a "constructor"
   * key goes to the SDK as a Map (storable() in client.ts), which plain
   * JSON.stringify would write as "{}", so Maps are measured as the maps they are.
   */
  static bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value, (_key, v: unknown) => (v instanceof Map ? Object.fromEntries(v) : v)), "utf8");

  private static tooBig = (item: Item) => MemoryTable.bytes(item) > MemoryTable.MAX_ITEM_BYTES;

  /**
   * What DynamoDB would get: each attribute or value marshalled as the
   * document client does it (one by one, dropping undefined and "__proto__"),
   * and read back. A value the SDK can't marshal throws as it would.
   */
  private static wire(values: Item | undefined): Item | undefined {
    if (values === undefined) return undefined;
    const out: Item = {};
    for (const [k, v] of Object.entries(values)) {
      if (v !== undefined && typeof v !== "function") out[k] = convertToNative(convertToAttr(v, { removeUndefinedValues: true, convertClassInstanceToMap: false }));
    }
    return out;
  }

  private static onWire(input: Input): Input {
    return {
      ...input,
      ...(input.Item ? { Item: MemoryTable.wire(input.Item) } : {}),
      ...(input.ExpressionAttributeValues ? { ExpressionAttributeValues: MemoryTable.wire(input.ExpressionAttributeValues) } : {}),
    };
  }

  put(item: Item): void {
    this.items.set(MemoryTable.id(item), structuredClone(item));
  }

  get(PK: string, SK: string): Item | undefined {
    return this.items.get(MemoryTable.id({ PK, SK }));
  }

  /** A team with members, as createTeam and acceptInvite would leave it. */
  seedTeam(teamId: string, members: Record<string, "owner" | "contributor" | "viewer">): void {
    const owners = Object.values(members).filter((role) => role === "owner").length;
    const count = Object.keys(members).length;
    this.put({ PK: `TEAM#${teamId}`, SK: "META", type: "team", teamId, name: teamId, homeRegion: REGION, owners, members: count, version: 1 });
    for (const [userId, role] of Object.entries(members)) this.put({ PK: `TEAM#${teamId}`, SK: `MEMBER#${userId}`, type: "member", teamId, userId, role });
  }

  /**
   * A Db on this table. With `team`, calls outside that team's partitions are
   * refused, as the data-access role refuses them (its operator audit,
   * `OPAUDIT#<team>`, is read-only there; tests check that separately).
   */
  db(team?: string): Db {
    return this.scoped(team === undefined ? undefined : [`TEAM#${team}`, `TEAM#${team}#SHEETS`, `OPAUDIT#${team}`]);
  }

  /** A Db allowed only the given partitions (PK, or the index partition for a query), like a LeadingKeys policy. */
  scoped(partitions: string[] | undefined): Db {
    return fakeDb(async (command) => this.send(command as { constructor: { name: string }; input: Input }, partitions && new Set(partitions)));
  }

  /**
   * A Db whose every call must first pass `check`, which sees the command's
   * name and its input as DynamoDB gets it: a stand-in for an IAM policy's
   * conditions (dynamodb:Attributes, dynamodb:Select, LeadingKeys patterns).
   * A refused call fails with AccessDeniedException and changes nothing.
   */
  guarded(check: (command: string, input: Record<string, unknown>) => boolean): Db {
    return fakeDb(async (command) => {
      const c = command as { constructor: { name: string }; input: Input };
      if (!check(c.constructor.name, MemoryTable.onWire(c.input))) {
        throw Object.assign(new Error(`not authorized to perform ${c.constructor.name} (policy)`), { name: "AccessDeniedException" });
      }
      return this.send(c, undefined);
    });
  }

  private allowed(ok: Set<string> | undefined, partitions: string[]): void {
    if (ok === undefined) return;
    if (partitions.some((p) => !ok.has(p))) {
      throw Object.assign(new Error("not authorized to perform dynamodb action (LeadingKeys)"), { name: "AccessDeniedException" });
    }
  }

  /** DynamoDB refuses empty name or value maps, and any name or value the expressions don't use. */
  private static checkExpressions(input: Input): void {
    const text = ["UpdateExpression", "ConditionExpression", "KeyConditionExpression", "ProjectionExpression", "FilterExpression"]
      .map((k) => input[k])
      .filter((e): e is string => typeof e === "string")
      .join(" ");
    for (const map of ["ExpressionAttributeNames", "ExpressionAttributeValues"] as const) {
      const keys = input[map] === undefined ? undefined : Object.keys(input[map] as object);
      if (keys?.length === 0) throw Object.assign(new Error(`${map} must not be empty`), { name: "ValidationException" });
      const unused = keys?.filter((k) => !new RegExp(`${k}(?![A-Za-z0-9_])`).test(text));
      if (unused?.length) throw Object.assign(new Error(`Value provided in ${map} unused in expressions: ${unused.join(", ")}`), { name: "ValidationException" });
    }
  }

  private send(command: { constructor: { name: string }; input: Input }, team: Set<string> | undefined): unknown {
    const name = command.constructor.name;
    const input = MemoryTable.onWire(command.input);
    if (input.TransactItems) {
      input.TransactItems = (input.TransactItems as Record<string, Input>[]).map((op) => Object.fromEntries(Object.entries(op).map(([kind, body]) => [kind, MemoryTable.onWire(body)])));
    }
    MemoryTable.checkExpressions(input);
    for (const op of (input.TransactItems as Record<string, Input>[] | undefined) ?? []) MemoryTable.checkExpressions(Object.values(op)[0] as Input);
    const record = (partitions: string[]) => {
      this.calls.push({ command: name, partitions });
      this.requests.push({ command: name, input });
      this.allowed(team, partitions);
    };
    switch (name) {
      case "GetCommand": {
        const key = input.Key as Item;
        record([String(key.PK)]);
        const item = this.items.get(MemoryTable.id(key));
        this.afterGet?.(item);
        return { Item: item && structuredClone(item) };
      }
      case "TransactGetCommand": {
        const gets = (input.TransactItems as { Get: { Key: Item } }[]).map((t) => t.Get.Key);
        record(gets.map((k) => String(k.PK)));
        return { Responses: gets.map((k) => ({ Item: structuredClone(this.items.get(MemoryTable.id(k))) })) };
      }
      case "PutCommand": {
        const item = input.Item as Item;
        record([String(item.PK)]);
        this.check(input, this.items.get(MemoryTable.id(item)));
        this.beforePut?.(item);
        if (MemoryTable.tooBig(item)) throw Object.assign(new Error("Item size has exceeded the maximum allowed size"), { name: "ValidationException" });
        this.items.set(MemoryTable.id(item), structuredClone(item));
        return {};
      }
      case "DeleteCommand": {
        const key = input.Key as Item;
        record([String(key.PK)]);
        const old = this.items.get(MemoryTable.id(key));
        this.check(input, old);
        this.items.delete(MemoryTable.id(key));
        return { Attributes: input.ReturnValues === "ALL_OLD" && old ? structuredClone(old) : undefined };
      }
      case "UpdateCommand": {
        const key = input.Key as Item;
        record([String(key.PK)]);
        const old = this.items.get(MemoryTable.id(key));
        this.check(input, old);
        this.items.set(MemoryTable.id(key), this.update(input, old ?? { ...key }));
        return {};
      }
      case "QueryCommand":
        return this.query(input, record);
      case "TransactWriteCommand":
        return this.transactWrite(input, record);
      default:
        throw new Error(`MemoryTable doesn't support ${name}`);
    }
  }

  private check(input: Input, item: Item | undefined): void {
    if (!input.ConditionExpression) return;
    const values = input.ExpressionAttributeValues ?? {};
    const at = (path: string) => (item ? MemoryTable.resolve(item, MemoryTable.path(path, input.ExpressionAttributeNames)) : undefined);
    const clause = (c: string): boolean => {
      const notExists = /^attribute_not_exists\((.+)\)$/.exec(c);
      if (notExists) return at(notExists[1] as string) === undefined;
      const exists = /^attribute_exists\((.+)\)$/.exec(c);
      if (exists) return at(exists[1] as string) !== undefined;
      const compare = /^(\S+) (=|<>|<=|>=|<|>) (:\S+)$/.exec(c);
      if (compare) {
        const [, name, op, value] = compare as unknown as [string, string, string, string];
        const [a, b] = [at(name), values[value]];
        // DynamoDB: a comparison with a missing attribute is false
        if (a === undefined) return false;
        if (op === "=") return JSON.stringify(a) === JSON.stringify(b);
        if (op === "<>") return JSON.stringify(a) !== JSON.stringify(b);
        const [x, y] = [a as number, b as number];
        return op === "<" ? x < y : op === ">" ? x > y : op === "<=" ? x <= y : x >= y;
      }
      throw new Error(`MemoryTable can't evaluate ${c}`);
    };
    const ok = MemoryTable.evaluate(input.ConditionExpression, clause);
    if (!ok) throw Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
  }

  /** Splits `text` at `separator` where it isn't inside parentheses. */
  private static splitTop(text: string, separator: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
      else if (depth === 0 && text.startsWith(separator, i)) {
        parts.push(text.slice(start, i));
        start = i + separator.length;
      }
    }
    return [...parts, text.slice(start)];
  }

  /** A condition with OR, AND and parenthesized groups, AND binding tighter, as DynamoDB reads it. */
  private static evaluate(expression: string, clause: (c: string) => boolean): boolean {
    const text = expression.trim();
    const any = MemoryTable.splitTop(text, " OR ");
    if (any.length > 1) return any.some((e) => MemoryTable.evaluate(e, clause));
    const all = MemoryTable.splitTop(text, " AND ");
    if (all.length > 1) return all.every((e) => MemoryTable.evaluate(e, clause));
    if (text.startsWith("(") && text.endsWith(")")) return MemoryTable.evaluate(text.slice(1, -1), clause);
    return clause(text);
  }

  /** `#a.#b` with its names resolved: ["items", "gloves"]. */
  private static path(expression: string, names: Record<string, string> = {}): string[] {
    return expression.split(".").map((part) => names[part] ?? part);
  }

  private static resolve(item: Item, path: string[]): unknown {
    let value: unknown = item;
    for (const part of path) {
      // Own fields only, as in DynamoDB: "constructor" isn't in every map
      if (typeof value !== "object" || value === null || Array.isArray(value) || !Object.hasOwn(value, part)) return undefined;
      value = (value as Item)[part];
    }
    return value;
  }

  /**
   * All or nothing, like DynamoDB: every condition is checked first, and a
   * failure cancels the lot with a reason per item. Update understands
   * `ADD a :v, ...`, `REMOVE a, b` and `SET a = :v, b = b + :v, c = if_not_exists(c, :z) + :v`, on paths (`#items.#line.#out`)
   * whose parent exists, as DynamoDB requires. ConditionCheck only checks.
   * `beforeTransactWrite` runs first: a concurrent writer.
   */
  private transactWrite(input: Input, record: (partitions: string[]) => void): unknown {
    this.beforeTransactWrite?.();
    type Op = { Put?: Input; Delete?: Input; Update?: Input; ConditionCheck?: Input };
    const ops = (input.TransactItems as Op[]).map((op) => {
      const [kind, body] = Object.entries(op)[0] as [string, Input];
      return { kind, body, key: (body.Item ?? body.Key) as Item };
    });
    record(ops.map((o) => String(o.key.PK)));
    // DynamoDB refuses a transaction over 4 MB before looking at any condition
    if (MemoryTable.bytes(input.TransactItems) > this.maxTransactionBytes) {
      throw Object.assign(new Error("Transaction request cannot be larger than 4 MB"), { name: "ValidationException" });
    }
    this.transactions.push(ops.length);
    const reasons = ops.map(({ body, key }) => {
      try {
        this.check(body, this.items.get(MemoryTable.id(key)));
        return { Code: "None" };
      } catch {
        return { Code: "ConditionalCheckFailed" };
      }
    });
    if (reasons.some((r) => r.Code !== "None")) {
      throw Object.assign(new Error("Transaction cancelled"), { name: "TransactionCanceledException", CancellationReasons: reasons });
    }
    // Build every change first: an item over the size limit cancels the lot
    const changes = ops.map(({ kind, body, key }) => {
      const id = MemoryTable.id(key);
      const next = kind === "Put" ? structuredClone(body.Item as Item) : kind === "Update" ? this.update(body, this.items.get(id) ?? { ...key }) : undefined;
      return { kind, id, next };
    });
    const sizes = changes.map(({ next }) =>
      next && MemoryTable.tooBig(next) ? { Code: "ValidationError", Message: "Item size to update has exceeded the maximum allowed size" } : { Code: "None" },
    );
    if (sizes.some((r) => r.Code !== "None")) {
      throw Object.assign(new Error("Transaction cancelled"), { name: "TransactionCanceledException", CancellationReasons: sizes });
    }
    for (const { kind, id, next } of changes) {
      if (kind === "Delete") this.items.delete(id);
      else if (next) this.items.set(id, next);
    }
    return {};
  }

  private update(input: Input & { UpdateExpression?: string }, item: Item): Item {
    const values = input.ExpressionAttributeValues ?? {};
    const next = structuredClone(item);
    const parentOf = (path: string[]): Item => {
      const parent = MemoryTable.resolve(next, path.slice(0, -1));
      if (typeof parent !== "object" || parent === null) {
        throw Object.assign(new Error("The document path provided in the update expression is invalid for update"), { name: "ValidationException" });
      }
      return parent as Item;
    };
    const number = (path: string[]) => (MemoryTable.resolve(next, path) as number | undefined) ?? 0;
    for (const [, verb, rest] of (input.UpdateExpression ?? "").matchAll(/(ADD|SET|REMOVE) (.+?)(?= (?:ADD|SET|REMOVE) |$)/g)) {
      // Split on commas outside parentheses: if_not_exists(a, :b) is one operand
      for (const part of (rest as string).split(/,(?![^(]*\))/).map((p) => p.trim())) {
        if (verb === "REMOVE") {
          const path = MemoryTable.path(part, input.ExpressionAttributeNames);
          Reflect.deleteProperty(parentOf(path), path[path.length - 1] as string);
        } else if (verb === "ADD") {
          const [name, value] = part.split(" ") as [string, string];
          const path = MemoryTable.path(name, input.ExpressionAttributeNames);
          const parent = parentOf(path);
          parent[path[path.length - 1] as string] = number(path) + (values[value] as number);
        } else {
          const [name, expression] = part.split(" = ") as [string, string];
          const path = MemoryTable.path(name, input.ExpressionAttributeNames);
          // `:v`, `a + :v` or `if_not_exists(a, :z) + :v`
          const sum = /^(?:if_not_exists\((\S+), (:\S+)\)|(\S+)) \+ (:\S+)$/.exec(expression);
          let value: unknown;
          if (!sum) value = structuredClone(values[expression]);
          else if (sum[1]) {
            const current = MemoryTable.resolve(next, MemoryTable.path(sum[1], input.ExpressionAttributeNames));
            value = ((current ?? values[sum[2] as string]) as number) + (values[sum[4] as string] as number);
          } else {
            const current = MemoryTable.resolve(next, MemoryTable.path(sum[3] as string, input.ExpressionAttributeNames));
            if (typeof current !== "number") throw Object.assign(new Error("An operand in the update expression has an incorrect data type"), { name: "ValidationException" });
            value = current + (values[sum[4] as string] as number);
          }
          parentOf(path)[path[path.length - 1] as string] = value;
        }
      }
    }
    return next;
  }

  private query(input: Input, record: (partitions: string[]) => void): unknown {
    const values = input.ExpressionAttributeValues ?? {};
    const index = input.IndexName as string | undefined;
    const [pkAttr, skAttr] = index ? [`${index}PK`, `${index}SK`] : ["PK", "SK"];
    const pk = String(values[":pk"]);
    record([pk]);
    const prefix = values[":prefix"] as string | undefined;
    const sk = values[":sk"] as string | undefined;
    // `<sort key> < :before`
    const before = /SK < :before\b/.test(String(input.KeyConditionExpression)) ? (values[":before"] as string) : undefined;
    let rows = [...this.items.values()]
      .filter((i) => i[pkAttr] === pk && (prefix === undefined || String(i[skAttr]).startsWith(prefix)) && (sk === undefined || i[skAttr] === sk))
      .filter((i) => before === undefined || String(i[skAttr]) < before)
      .sort((a, b) => (String(a[skAttr]) < String(b[skAttr]) ? -1 : String(a[skAttr]) > String(b[skAttr]) ? 1 : 0));
    if (input.ScanIndexForward === false) rows.reverse();
    const start = input.ExclusiveStartKey as Item | undefined;
    if (start) {
      const at = rows.findIndex((r) => r.PK === start.PK && r.SK === start.SK);
      if (at < 0) throw Object.assign(new Error("The provided starting key is invalid"), { name: "ValidationException" });
      rows = rows.slice(at + 1);
    }
    // Select COUNT returns how many match and no items (one page here: nothing in memory is near 1 MB)
    if (input.Select === "COUNT") return { Count: rows.length };
    const limit = input.Limit as number | undefined;
    const page = limit ? rows.slice(0, limit) : rows;
    const last = limit && rows.length > limit ? page[page.length - 1] : undefined;
    const lastKey = last && (index ? { PK: last.PK, SK: last.SK, [pkAttr]: last[pkAttr], [skAttr]: last[skAttr] } : { PK: last.PK, SK: last.SK });
    const projected = index ? PROJECTIONS[index] : undefined;
    const project = (i: Item): Item =>
      projected ? Object.fromEntries(Object.entries(i).filter(([k]) => ["PK", "SK", pkAttr, skAttr, ...projected].includes(k))) : i;
    return { Items: page.map((i) => structuredClone(project(i))), LastEvaluatedKey: lastKey };
  }
}
