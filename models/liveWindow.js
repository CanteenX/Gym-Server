/**
 * THE ONE DEFINITION OF "CURRENTLY LIVE" for every scheduled, self-expiring row
 * on the public website — adverts (models/Advertisement.js) and announcements
 * and banners (models/SiteNotice.js) today, anything else that grows a
 * startAt/endAt pair tomorrow.
 *
 * WHY startAt/endAt RATHER THAN A CRON THAT FLIPS isActive: a scheduled job that
 * toggles a flag is a second source of truth that drifts the moment the job
 * misses a run, and it cannot be reasoned about from the row alone. The live
 * window is evaluated at read time instead, so a row always explains its own
 * visibility and a mis-set date is fixed by editing the row, not by waiting for
 * a job.
 *
 * "Currently live" is: isActive AND (startAt unset or <= now) AND
 * (endAt unset or >= now).
 *
 * WHY THIS FILE EXISTS RATHER THAN A COPY PER MODEL — and this is not a
 * hypothetical. The rule used to live inside models/Advertisement.js with a
 * comment saying "never re-write it inline, or the admin 'is it live?' badge
 * and the public endpoint will eventually disagree". The moment a second
 * content type needed scheduling, honouring that comment meant either making
 * SiteNotice import the Advertisement model (a notice is not an advert, and
 * that dependency would be a lie about the domain) or copying the expression
 * (exactly what the comment forbids). So the rule moved here, where both can
 * import it and neither owns it. Advertisement.js re-exports the pair, so every
 * existing importer is unchanged.
 *
 * THE CONCRETE FAILURE IT GUARDS: the owner once set a two-minute window on an
 * advert and it vanished, correctly, two minutes later. The admin list must be
 * able to say scheduled/live/expired using the SAME expression the public
 * endpoint filters on, or the panel will insist a row is live while the site
 * refuses to serve it.
 */

/**
 * The Mongo filter fragment for "currently live".
 *
 * NOTE ON $and: the two open-ended checks are each a $or, so they cannot both
 * sit at the top level of one filter object — the second would overwrite the
 * first. Callers may still add their own top-level keys (`kind`, `placement`)
 * to the returned object; only `$and` and `isActive` are spoken for.
 *
 * @param {Date} [now]
 * @returns {object} filter fragment to spread into, or use as, a query
 */
export const liveWindowFilter = (now = new Date()) => ({
  isActive: true,
  $and: [
    { $or: [{ startAt: null }, { startAt: { $lte: now } }] },
    { $or: [{ endAt: null }, { endAt: { $gte: now } }] },
  ],
});

/**
 * The same rule applied to an already-loaded row, so an admin list can show a
 * live/scheduled/expired badge without a second query.
 *
 * @param {{isActive: boolean, startAt: Date|null, endAt: Date|null}} row
 * @param {Date} [now]
 * @returns {boolean}
 */
export const isCurrentlyLive = (row, now = new Date()) => {
  if (!row?.isActive) return false;
  if (row.startAt && new Date(row.startAt) > now) return false;
  if (row.endAt && new Date(row.endAt) < now) return false;
  return true;
};

/**
 * Why a row is not live, for the admin badge. Derived from the SAME two checks
 * above rather than re-deciding them, so the badge and the filter cannot
 * disagree about a row sitting exactly on its boundary.
 *
 * @param {{isActive: boolean, startAt: Date|null, endAt: Date|null}} row
 * @param {Date} [now]
 * @returns {"LIVE"|"SCHEDULED"|"EXPIRED"|"INACTIVE"}
 */
export const liveStatus = (row, now = new Date()) => {
  if (isCurrentlyLive(row, now)) return "LIVE";
  // Order matters: a row switched off by hand is INACTIVE even if its dates
  // would otherwise be in the future, because "switch it back on" is the fix,
  // not "wait".
  if (!row?.isActive) return "INACTIVE";
  if (row.startAt && new Date(row.startAt) > now) return "SCHEDULED";
  return "EXPIRED";
};
