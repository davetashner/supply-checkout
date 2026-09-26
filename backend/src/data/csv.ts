// A small RFC 4180 CSV reader for the inventory import (imports.ts). It reads
// what spreadsheet apps save: comma-separated, fields optionally in double
// quotes (a quote inside one doubled), CRLF, LF or CR line ends, and an
// optional byte-order mark. It's bounded: callers pass the most records and
// fields per record they accept, and it stops with InvalidInputError past
// either, so a hostile file can't make it build a huge structure.

import { InvalidInputError } from "./errors.js";

export interface CsvRecord {
  /** The line of the file (from 1) that the record starts on. */
  readonly line: number;
  readonly cells: string[];
}

export interface CsvLimits {
  /** Records, header included. Blank lines don't count. */
  readonly maxRecords: number;
  readonly maxFields: number;
}

/** Records in `text`, skipping blank lines. Throws InvalidInputError for a quote that never closes, or past a limit. */
export function parseCsv(text: string, limits: CsvLimits): CsvRecord[] {
  const records: CsvRecord[] = [];
  const src = text.startsWith("﻿") ? text.slice(1) : text;
  let cells: string[] = [];
  let cell = "";
  let line = 1;
  let start = 1;
  let quoted = false;
  let quoteLine = 0;
  // Whether the current record has any content yet: a blank line has none
  let any = false;

  const endCell = () => {
    cells.push(cell);
    cell = "";
    if (cells.length > limits.maxFields) throw new InvalidInputError(`Line ${start} has more than ${limits.maxFields} columns`);
  };
  const endRecord = () => {
    endCell();
    if (any) {
      records.push({ line: start, cells });
      if (records.length > limits.maxRecords) throw new InvalidInputError(`The file has more than ${limits.maxRecords - 1} rows`);
    }
    cells = [];
    any = false;
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        if (c === "\n" || (c === "\r" && src[i + 1] !== "\n")) line++;
        cell += c;
      }
      continue;
    }
    if (c === '"' && cell === "") {
      quoted = true;
      quoteLine = line;
      any = true;
    } else if (c === ",") {
      any = true;
      endCell();
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      endRecord();
      line++;
      start = line;
    } else {
      // A quote in the middle of an unquoted field is kept as it is, as spreadsheets do
      cell += c;
      any = true;
    }
  }
  if (quoted) throw new InvalidInputError(`The quote that starts on line ${quoteLine} never closes`);
  endRecord();
  return records;
}
