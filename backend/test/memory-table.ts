// An in-memory stand-in for the app table, for handler tests that run without
// DynamoDB Local. It understands only the commands and expressions the
// document functions and authorizeTeam send. Each Db it hands out can be
// scoped to one team, the way the data-access role's dynamodb:LeadingKeys
// condition scopes a role session: a call that names any other partition is
// refused with AccessDeniedException.

import type { Db } from "../src/data/index.js";
import { fakeDb, REGION } from "./helpers.js";

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
  /** Runs after each GetCommand, before its result returns: a concurrent writer. */
  afterGet?: (item: Item | undefined) => void;

  private static id = (k: Item) => `${String(k.PK)}\u0000${String(k.SK)}`;

  put(item: Item): void {
    this.items.set(MemoryTable.id(item), structuredClone(item));
  }

  get(PK: string, SK: string): Item | undefined {
    return this.items.get(MemoryTable.id({ PK, SK }));
  }

  /** A team with members, as createTeam and acceptInvite would leave it. */
  seedTeam(teamId: string, members: Record<string, "owner" | "contributor" | "viewer">): void {
    this.put({ PK: `TEAM#${teamId}`, SK: "META", type: "team", teamId, name: teamId, homeRegion: REGION, version: 1 });
    for (const [userId, role] of Object.entries(members)) this.put({ PK: `TEAM#${teamId}`, SK: `MEMBER#${userId}`, type: "member", teamId, userId, role });
  }

  /** A Db on this table. With `team`, calls outside that team's partitions are refused. */
  db(team?: string): Db {
    return fakeDb(async (command) => this.send(command as { constructor: { name: string }; input: Input }, team));
  }

  private allowed(team: string | undefined, partitions: string[]): void {
    if (team === undefined) return;
    const ok = new Set([`TEAM#${team}`, `TEAM#${team}#SHEETS`]);
    if (partitions.some((p) => !ok.has(p))) {
      throw Object.assign(new Error("not authorized to perform dynamodb action (LeadingKeys)"), { name: "AccessDeniedException" });
    }
  }

  private send(command: { constructor: { name: string }; input: Input }, team: string | undefined): unknown {
    const name = command.constructor.name;
    const input = command.input;
    const record = (partitions: string[]) => {
      this.calls.push({ command: name, partitions });
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
      case "QueryCommand":
        return this.query(input, record);
      default:
        throw new Error(`MemoryTable doesn't support ${name}`);
    }
  }

  private check(input: Input, item: Item | undefined): void {
    if (!input.ConditionExpression) return;
    const names = input.ExpressionAttributeNames ?? {};
    const values = input.ExpressionAttributeValues ?? {};
    const attr = (s: string) => names[s] ?? s;
    const ok = input.ConditionExpression.split(" AND ").every((clause) => {
      const notExists = /^attribute_not_exists\((.+)\)$/.exec(clause);
      if (notExists) return !item || item[attr(notExists[1] as string)] === undefined;
      const equals = /^(\S+) = (:\S+)$/.exec(clause);
      if (equals) return !!item && JSON.stringify(item[attr(equals[1] as string)]) === JSON.stringify(values[equals[2] as string]);
      throw new Error(`MemoryTable can't evaluate ${clause}`);
    });
    if (!ok) throw Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
  }

  private query(input: Input, record: (partitions: string[]) => void): unknown {
    const values = input.ExpressionAttributeValues ?? {};
    const index = input.IndexName === "GSI1";
    const [pkAttr, skAttr] = index ? ["GSI1PK", "GSI1SK"] : ["PK", "SK"];
    const pk = String(values[":pk"]);
    record([pk]);
    const prefix = values[":prefix"] as string | undefined;
    let rows = [...this.items.values()]
      .filter((i) => i[pkAttr] === pk && (prefix === undefined || String(i[skAttr]).startsWith(prefix)))
      .sort((a, b) => (String(a[skAttr]) < String(b[skAttr]) ? -1 : String(a[skAttr]) > String(b[skAttr]) ? 1 : 0));
    if (input.ScanIndexForward === false) rows.reverse();
    const start = input.ExclusiveStartKey as Item | undefined;
    if (start) {
      const at = rows.findIndex((r) => r.PK === start.PK && r.SK === start.SK);
      if (at < 0) throw Object.assign(new Error("The provided starting key is invalid"), { name: "ValidationException" });
      rows = rows.slice(at + 1);
    }
    const limit = input.Limit as number | undefined;
    const page = limit ? rows.slice(0, limit) : rows;
    const last = limit && rows.length > limit ? page[page.length - 1] : undefined;
    const lastKey = last && (index ? { PK: last.PK, SK: last.SK, GSI1PK: last.GSI1PK, GSI1SK: last.GSI1SK } : { PK: last.PK, SK: last.SK });
    return { Items: page.map((i) => structuredClone(i)), LastEvaluatedKey: lastKey };
  }
}
