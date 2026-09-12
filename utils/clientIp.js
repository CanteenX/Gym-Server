/**
 * The client's IP address, for RATE LIMITING.
 *
 * This is the only thing that still needs it. The staff and employee login
 * flows used to record an IP and a geolocation lookup against every attempt;
 * that was removed along with the consent checkboxes, so `LoginAttempt` no
 * longer stores anything about where a request came from. Account lockout is
 * keyed on the user, not the address, and is unaffected.
 *
 * `req.ip` is the wrong source here. Express derives it from the `trust proxy`
 * hop count, which is set to 1 - correct when exactly one Vercel edge sat in
 * front of the function. Since the deployment was split, a request to the
 * public domain also passes through the front-end project's rewrite, so there
 * is one more hop than the setting accounts for and `req.ip` resolves to an
 * intermediate infrastructure address. Keying the rate limiter on that would
 * bucket unrelated visitors together.
 *
 * The left-most `x-forwarded-for` entry is the original client as reported by
 * the first proxy that saw it, and it is hop-count independent, so changing
 * `trust proxy` cannot silently move the answer again.
 *
 * Caveat: this is only as trustworthy as the edge that wrote the header. It is
 * the right choice for rate limiting and it must NOT be treated as proof of
 * origin.
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
