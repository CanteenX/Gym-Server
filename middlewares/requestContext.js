/**
 * Per-request context, carried through async calls with AsyncLocalStorage.
 *
 * ============================================================================
 * WHY THIS EXISTS: MONGOOSE MIDDLEWARE CANNOT SEE THE REQUEST.
 * ============================================================================
 *
 * The audit log has to record WHO changed a row. A mongoose hook is the only
 * place that cannot be forgotten at a call site — every save/update/delete goes
 * through it, including the ones somebody adds next year. But a hook is handed
 * a document or a query and nothing else: there is no `req`, no session, no
 * way to name an actor. Passing the actor into every controller call instead
 * puts the burden back on the call site, which is exactly the failure mode the
 * hook was chosen to avoid.
 *
 * AsyncLocalStorage closes that gap. `storage.run(store, next)` makes `store`
 * visible to everything that runs inside `next()` — including code reached
 * through `await`, promises and timers — without threading an argument
 * through. A mongoose hook fires synchronously inside the await chain of the
 * controller that triggered it, so it is inside that same async context and
 * `getRequestContext()` returns this request's store.
 *
 * Verified for this codebase (Node >= 22):
 *   - Works under the long-running PM2 process AND under the Vercel serverless
 *     function; a function invocation is one request, so there is no
 *     cross-request bleed to worry about either way.
 *   - Survives `await`, `Promise.all`, mongoose's own internal promise chains
 *     and the connection buffering queue, because the context is captured when
 *     the operation is CREATED, not when it resolves.
 *   - The one genuine hole: a write with no request behind it at all — a seed
 *     script, a CLI job, a boot-time migration — has no store. That is treated
 *     as "not an audited event" rather than guessed at; see services/auditLog.js.
 *
 * THE STORE HOLDS `req`, NOT A COPY OF THE USER. Login sets `req.session.user`
 * partway through a request, and a snapshot taken when this middleware ran
 * would still be null by the time a hook fires. Reading through the live `req`
 * also keeps the rule the rest of the server follows: the actor comes from
 * `req.session.user`, never from `req.user` — which authMiddleware builds from
 * four fields and which carries NO branch (see middlewares/branchScope.js).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { getClientIp } from "../utils/clientIp.js";

const storage = new AsyncLocalStorage();

/**
 * Express middleware. Must be mounted AFTER express-session (so `req.session`
 * exists) and BEFORE the route table (so every handler runs inside the store).
 */
export const requestContext = (req, res, next) => {
  storage.run({ req, startedAt: Date.now() }, () => next());
};

/** The current request's store, or null when there is no request. */
export const getRequestContext = () => storage.getStore() || null;

/**
 * The STAFF actor behind the current request, or null.
 *
 * Resolved lazily from `req.session.user` every time it is asked for, because
 * the session is populated during the request on the login path.
 *
 * Returns null for:
 *   - anonymous calls (public CMS reads, the contact form),
 *   - member-portal calls, which authenticate with a JWT bearer token and
 *     never create `req.session.user`,
 *   - anything running outside a request (seeds, scripts, cron).
 * Each of those is "no staff actor", which the audit log treats as "not an
 * audited event" rather than inventing an actor for it.
 */
export const getRequestActor = () => {
  const store = storage.getStore();
  const sessionUser = store?.req?.session?.user;
  if (!sessionUser?.id) return null;

  return {
    id: String(sessionUser.id),
    name: sessionUser.name || "",
    email: sessionUser.email || "",
    role: sessionUser.role || "",
    // null means all branches — the same convention branchScope.js uses.
    branch: sessionUser.branch || null,
    isSuperAdmin: Boolean(sessionUser.isSuperAdmin),
  };
};

/** Request metadata worth keeping on an audit row. */
export const getRequestMeta = () => {
  const store = storage.getStore();
  const req = store?.req;
  if (!req) return { ip: "", userAgent: "", method: "", path: "" };

  return {
    // Not proof of origin — see utils/clientIp.js. Good enough to tell two
    // simultaneous sessions apart, which is what an audit trail needs.
    ip: getClientIp(req) || "",
    userAgent: String(req.headers?.["user-agent"] || "").slice(0, 300),
    method: req.method || "",
    path: (req.originalUrl || req.url || "").split("?")[0].slice(0, 300),
  };
};

/**
 * Escape hatch for code that legitimately runs outside a request but still
 * wants its writes attributed — a future admin-triggered background job, say.
 * Nothing uses it yet; it exists so that such a job has a supported way in
 * rather than reaching for a module-level global.
 */
export const runWithContext = (store, fn) => storage.run(store, fn);
