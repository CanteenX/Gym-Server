import Counter from "../models/Counter.js";

/**
 * Indian financial year label for a date: April–March.
 * 11 Sep 2026 → "2026-27";  11 Feb 2027 → "2026-27".
 *
 * Receipts are numbered per FY because that is the boundary an Indian
 * accountant reconciles against.
 */
export const financialYearOf = (date = new Date()) => {
  const d = new Date(date);
  const year = d.getFullYear();
  // Months are 0-indexed: 3 === April.
  const startYear = d.getMonth() >= 3 ? year : year - 1;
  const endShort = String((startYear + 1) % 100).padStart(2, "0");
  return `${startYear}-${endShort}`;
};

/**
 * Reserve the next receipt number, e.g. "MCG/2026-27/00001".
 *
 * Uses an atomic counter, so concurrent payments cannot collide on the same
 * number. The sequence restarts each financial year.
 */
export const nextReceiptNumber = async (date = new Date(), prefix = "MCG") => {
  const fy = financialYearOf(date);
  const seq = await Counter.nextValue(`receipt:${fy}`);
  return `${prefix}/${fy}/${String(seq).padStart(5, "0")}`;
};

export default { nextReceiptNumber, financialYearOf };
