/**
 * Last-resort scrub of credential fields from every JSON response.
 *
 * WHY THIS EXISTS WHEN THE SCHEMAS ALREADY STRIP THE FIELD.
 * The schema-level defences (select:false plus a toJSON/toObject transform on
 * CompanyMaster, Employee, Member and Trainer) only apply to Mongoose
 * DOCUMENTS. Two very common shapes slip straight past them:
 *
 *   1. `.aggregate()` — returns plain objects the schema never touches. The
 *      staff list endpoint POST /employees-by-params is exactly this, and its
 *      $facet/$lookup pipeline was handing every row's bcrypt hash to the admin
 *      panel, including a second copy nested under `createdByEmployee`.
 *   2. `.lean()` — same story, no document, no transform.
 *
 * A nested `$lookup` hash cannot be fixed from the schema at all, so a response
 * boundary is the only place one net catches everything. This runs on the way
 * out, after the handler has built its body, and knows nothing about which
 * collection the data came from — which is the point: a new endpoint, a new
 * aggregation or a new model is covered on the day it is written, with nobody
 * having to remember anything.
 *
 * It is a NET, not the fix. Keep the schema-level stripping in place: this one
 * middleware being removed or mis-mounted must not be enough to expose a hash,
 * and a handler that bypasses res.json (res.send with a pre-built string, a
 * stream) is not covered here.
 */

/**
 * Response keys that may never reach a client, whatever the nesting depth.
 *
 * `password` — CompanyMaster / Employee (staff, session auth).
 * `passwordHash` — Member / Trainer (portal, JWT auth).
 * Both spellings are listed because the two auth systems are deliberately
 * separate and named their field differently; see CLAUDE.md.
 */
const SECRET_KEYS = new Set(["password", "passwordHash"]);

/**
 * Only plain objects are walked. A Date, ObjectId, Buffer or Mongoose document
 * is returned untouched: documents are already covered by their schema
 * transform, and blindly copying the others would corrupt them (an ObjectId
 * spread into a plain object serialises as its internal buffer, not as a hex
 * string).
 */
const isPlainObject = (value) => {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Returns a scrubbed copy, or THE SAME REFERENCE when nothing had to change.
 *
 * Copy-on-write rather than mutating in place: the body handed to res.json may
 * still be referenced by the caller (a cached lookup, a document the handler
 * goes on to save), and quietly deleting a field from it would be a bug that
 * only shows up much later. Returning the original when clean also means the
 * overwhelming majority of responses — which carry no credential field at all —
 * allocate nothing.
 */
const scrub = (value, depth = 0) => {
  // Cheap guard against a pathological or cyclic structure. Nothing in this API
  // nests anywhere near this deep; a body that does is left alone rather than
  // risking a stack overflow inside the response path.
  if (depth > 20) return value;

  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const scrubbed = scrub(item, depth + 1);
      if (scrubbed !== item) changed = true;
      return scrubbed;
    });
    return changed ? next : value;
  }

  if (!isPlainObject(value)) return value;

  let changed = false;
  const next = {};

  for (const key of Object.keys(value)) {
    if (SECRET_KEYS.has(key)) {
      changed = true;
      continue;
    }
    const scrubbed = scrub(value[key], depth + 1);
    if (scrubbed !== value[key]) changed = true;
    next[key] = scrubbed;
  }

  return changed ? next : value;
};

/**
 * Wraps res.json for the lifetime of the request.
 *
 * Mount this BEFORE the route handlers or the wrapper is never installed.
 */
export const stripResponseSecrets = (req, res, next) => {
  const originalJson = res.json.bind(res);

  res.json = (body) => originalJson(scrub(body));

  next();
};

// Exported for the unit tests; not part of the middleware contract.
export const __scrubForTests = scrub;

export default stripResponseSecrets;
