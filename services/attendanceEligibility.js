/**
 * May this person start a session right now, and if not, why not?
 *
 * ============================================================================
 * PURE ON PURPOSE: NO MONGOOSE, NO EXPRESS, NO CLOCK OF ITS OWN.
 * ============================================================================
 * Everything here is a plain function over a plain object. That is what makes
 * scripts/tests/eligibility.test.mjs an offline unit test rather than something
 * that needs a database, and it is the reason the rules can be tested at all.
 *
 * WHY THESE RULES NEED TESTS MORE THAN THE REST OF THE PHASE (plan.md, Phase 3
 * risk note): nobody is at the door. A wrong DENY tells a paying member, on
 * their own phone, that their membership has lapsed — with no member of staff
 * standing there to say "no, that's wrong, come in". The verdict IS the whole
 * user-visible behaviour of the feature, so it is the thing that gets pinned
 * down by assertions instead of by careful reading.
 *
 * WHAT A VERDICT IS AND IS NOT:
 *   - It is advice to the member and a flag to the front desk.
 *   - It is NOT a door. Check-in is unattended and the QR is a printed sticker
 *     (plan.md D2), so a DENY cannot refuse entry and must never be worded as
 *     though it had. Every message below therefore points at reception.
 */

/** The four refusal reasons. Codes, not prose — the portal maps them to copy. */
export const DENY_REASONS = {
  EXPIRED: "EXPIRED",
  PAYMENT_DUE: "PAYMENT_DUE",
  INACTIVE: "INACTIVE",
  NOT_A_MEMBER: "NOT_A_MEMBER",
};

export const VERDICT = {
  ALLOW: "ALLOW",
  DENY: "DENY",
};

/**
 * Reception-pointing copy for each refusal.
 *
 * Kept beside the codes rather than in the controller so a new reason cannot be
 * added with no message, and so the "see reception" ending is visible in one
 * place — a DENY that dead-ends is the failure mode plan.md calls out by name.
 */
const DENY_MESSAGES = {
  [DENY_REASONS.EXPIRED]:
    "Your membership has ended. Please see reception to renew — you can still train today.",
  [DENY_REASONS.PAYMENT_DUE]:
    "There is a pending balance on your membership. Please see reception to clear it.",
  [DENY_REASONS.INACTIVE]:
    "Your membership is marked inactive. Please see reception and they will sort it out.",
  [DENY_REASONS.NOT_A_MEMBER]:
    "We could not find an active membership for this account. Please see reception.",
};

/** Midnight local. A membership that ends today has NOT ended yet. */
const startOfDay = (value) => {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
};

const allow = (message) => ({
  verdict: VERDICT.ALLOW,
  reason: null,
  message,
});

const deny = (reason) => ({
  verdict: VERDICT.DENY,
  reason,
  message: DENY_MESSAGES[reason] || DENY_MESSAGES[DENY_REASONS.NOT_A_MEMBER],
});

/**
 * Eligibility for a MEMBER.
 *
 * @param {object|null} member  needs only { isActive, endDate, totalFee,
 *   payments[] | balanceAmount }. A lean() object works as well as a document,
 *   which is why balanceAmount is accepted both as the Mongoose virtual and as
 *   something derivable from totalFee minus payments.
 * @param {Date} [now]  injected so a test can sit on a date boundary without
 *   waiting for midnight.
 *
 * ORDER IS PART OF THE CONTRACT, and it is the same order memberLogin already
 * uses: inactive, then expired, then money. A member whose record was switched
 * off must not be told to go and pay a balance that is no longer owed, and an
 * expired member must be told to renew rather than to settle a bill — renewing
 * is the action that actually fixes their situation.
 */
export const evaluateMemberEligibility = (member, now = new Date()) => {
  if (!member) return deny(DENY_REASONS.NOT_A_MEMBER);

  // Explicitly `=== false`, not `!member.isActive`: a lean projection that did
  // not select isActive leaves it undefined, and treating undefined as "switched
  // off" would deny a perfectly good member because of a missing field.
  if (member.isActive === false) return deny(DENY_REASONS.INACTIVE);

  const today = startOfDay(now);
  const end = member.endDate ? startOfDay(member.endDate) : null;
  // `<` and not `<=`: the last day of a membership is a day you may train.
  if (end && today && end < today) return deny(DENY_REASONS.EXPIRED);

  if (balanceOf(member) > 0) return deny(DENY_REASONS.PAYMENT_DUE);

  return allow("Checked in. Have a good session.");
};

/**
 * What the member still owes for the current period.
 *
 * Prefers the `balanceAmount` virtual when the caller handed us a real
 * document, and falls back to recomputing it from totalFee minus payments for a
 * lean object, where virtuals do not exist. Never negative — an overpayment is
 * not a reason to deny anybody.
 *
 * Note this reads Member.payments deliberately. That is the CURRENT-PERIOD
 * balance, which is exactly the question here; the Transaction ledger is the
 * right source for reporting and the wrong one for "does this person owe money
 * today" (see the domain notes in CLAUDE.md).
 */
const balanceOf = (member) => {
  if (typeof member.balanceAmount === "number") {
    return Math.max(0, member.balanceAmount);
  }
  const paid = (member.payments || []).reduce(
    (sum, p) => sum + (p?.amount || 0),
    0,
  );
  return Math.max(0, (member.totalFee || 0) - paid);
};

/**
 * Eligibility for a TRAINER.
 *
 * Always ALLOW, per the contract — a trainer has no subscription, no end date
 * and no balance, so there is nothing that could produce a refusal. The only
 * thing that can stop a trainer is the record being switched off, and a
 * deactivated trainer cannot hold a valid login in the first place (the login
 * handler filters on isActive), so this is here for completeness and so that
 * every caller has one function to call whatever the subject is.
 */
export const evaluateTrainerEligibility = (trainer) => {
  if (!trainer) return deny(DENY_REASONS.NOT_A_MEMBER);
  if (trainer.isActive === false) return deny(DENY_REASONS.INACTIVE);
  return allow("Shift started. Have a good day.");
};

/**
 * The one entry point the scan handler uses.
 *
 * @param {"MEMBER"|"TRAINER"} subjectType  from the VERIFIED JWT, never the body.
 */
export const evaluateEligibility = (subjectType, subject, now = new Date()) =>
  subjectType === "TRAINER"
    ? evaluateTrainerEligibility(subject)
    : evaluateMemberEligibility(subject, now);
