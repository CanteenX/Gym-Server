/**
 * CSV generation for the server-side exports.
 *
 * TWO THINGS THIS FILE EXISTS TO GET RIGHT:
 *
 * 1. CSV INJECTION. A cell beginning `=`, `+`, `-`, `@`, a tab or a carriage
 *    return is interpreted as a FORMULA by Excel, Google Sheets and LibreOffice
 *    — `=HYPERLINK(...)` or a DDE call that runs on open. The gym's member
 *    notes, lead messages and expense descriptions are free text typed by
 *    whoever is at the desk and re-exported to whoever asked for the report, so
 *    the export is a real path from "someone typed it" to "someone's laptop ran
 *    it". Every cell is prefixed with an apostrophe when it starts with one of
 *    those characters, which every spreadsheet reads as "this is text".
 *
 * 2. MEMORY. `rows.map(csvRow).join("\n")` builds the entire file in the
 *    function's heap before a byte is sent — on a 1024 MB serverless function
 *    that is a hard ceiling, not a slowdown, and the failure is an OOM kill
 *    with no error body. streamCsv() writes row by row from a database cursor
 *    and respects backpressure, so peak memory is one row plus the socket
 *    buffer regardless of how many rows there are.
 */

/** Characters a spreadsheet treats as the start of a formula. */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/** One CSV cell: injection-neutralised, quoted and escaped. */
export const csvCell = (value) => {
  if (value === null || value === undefined) return "";

  let text;
  if (value instanceof Date) text = value.toISOString();
  else if (typeof value === "object") text = JSON.stringify(value);
  else text = String(value);

  // Neutralise before quoting — the apostrophe has to be inside the quotes.
  if (FORMULA_PREFIX.test(text)) text = `'${text}`;

  if (/["\n\r,]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
};

/** One CSV line, CRLF-terminated (what Excel expects). */
export const csvRow = (values) => `${values.map(csvCell).join(",")}\r\n`;

/**
 * Writes `chunk` and waits for the socket to drain if it is full.
 *
 * Without this, a fast cursor and a slow client queue every unwritten row in
 * memory — which is the exact problem streaming was supposed to avoid.
 */
const writeBackpressured = (res, chunk) =>
  new Promise((resolve) => {
    if (res.write(chunk)) return resolve();
    res.once("drain", resolve);
  });

/**
 * Streams a CSV response from a mongoose cursor.
 *
 * @param {import("express").Response} res
 * @param {object}   options
 * @param {string}   options.filename     download name, no path
 * @param {Array<{key:string,label:string,get?:Function}>} options.columns
 * @param {object}   options.cursor       a mongoose QueryCursor
 * @param {number}   options.maxRows      hard cap; the file ends with a note
 * @returns {Promise<number>} rows written
 */
export const streamCsv = async (res, { filename, columns, cursor, maxRows }) => {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename.replace(/[^\w.\-]/g, "_")}"`,
  );
  // An export is a point-in-time extract; a cached copy is a wrong copy.
  res.setHeader("Cache-Control", "no-store");

  // UTF-8 BOM. Without it Excel on Windows reads the file as the system
  // codepage and mangles every non-ASCII name in the member list.
  await writeBackpressured(res, "﻿");
  await writeBackpressured(res, csvRow(columns.map((c) => c.label)));

  let count = 0;
  let capped = false;

  for await (const doc of cursor) {
    if (count >= maxRows) {
      capped = true;
      break;
    }
    await writeBackpressured(
      res,
      csvRow(columns.map((c) => (c.get ? c.get(doc) : doc?.[c.key]))),
    );
    count += 1;
  }

  // Close the cursor explicitly: breaking out of the loop early leaves it open
  // on the server otherwise, holding a connection from the pool.
  await cursor.close?.();

  if (capped) {
    // Said in the file rather than only in a header, because the header is
    // gone by the time somebody opens the spreadsheet and wonders why the
    // total does not match the screen.
    await writeBackpressured(
      res,
      csvRow([
        `TRUNCATED — only the first ${maxRows} rows are included. Narrow the date range and export again.`,
      ]),
    );
  }

  res.end();
  return count;
};
