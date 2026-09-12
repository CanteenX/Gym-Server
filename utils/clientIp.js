/**
 * The one place that decides what "the client's IP address" means.
 *
 * This existed in three places with two different answers. `rateLimiter.js`
 * read the left-most `x-forwarded-for` entry; the staff and employee login
 * controllers preferred `req.ip` and fell back to the ENTIRE raw header
 * (producing "1.2.3.4, 10.0.0.1" as a single "address" when it did).
 *
 * `req.ip` is the wrong choice here. Express derives it from the
 * `trust proxy` hop count, which is set to 1 - correct when exactly one Vercel
 * edge sat in front of the function. Since the deployment was split, a request
 * to the public domain reaches this app through the front-end project's rewrite
 * as well, so there is one more hop than the setting accounts for and `req.ip`
 * resolves to an intermediate infrastructure address rather than the visitor.
 *
 * That matters because these values are what `LoginAttempt` stores and what
 * `geoip.lookup()` is given: with the wrong value, a brute-force attempt is
 * recorded and geo-located against Vercel's own infrastructure instead of the
 * attacker. Account lockout is keyed on the user, not the IP, so enforcement
 * is unaffected - only the forensic trail was wrong.
 *
 * The left-most `x-forwarded-for` entry is the original client as reported by
 * the first proxy that saw it, and it is hop-count independent, so raising or
 * lowering `trust proxy` cannot silently change the answer again.
 *
 * Caveat worth knowing: this is only as trustworthy as the edge that wrote the
 * header. It is the right choice for an audit trail and for rate limiting, and
 * it must NOT be treated as proof of origin.
 */
export const getClientIp = (req) => {
  const forwarded = req.headers["x-forwarded-for"];
  const first =
    typeof forwarded === "string"
      ? forwarded.split(",")[0].trim()
      : Array.isArray(forwarded)
        ? String(forwarded[0] || "").split(",")[0].trim()
        : "";

  return (
    first ||
    req.headers["x-real-ip"] ||
    req.ip ||
    req.connection?.remoteAddress ||
    "unknown"
  );
};
