/**
 * The one and only SMTP transport in this codebase.
 *
 * WHY THIS EXISTS: nodemailer.createTransport() was being called inline inside
 * controllers/v1/otp.controller.js, which meant (a) a fresh TCP+TLS handshake
 * to Gmail on every single send, (b) the provider quirk ("gmail" needs
 * `service` rather than host/port) duplicated wherever a second feature wanted
 * to send mail, and (c) no single place to look when delivery breaks. Every
 * outbound email now goes through sendMail() below.
 *
 * WHERE THE CREDENTIALS LIVE: in MONGO, not in the environment. `EmailSetup`
 * holds host / port / SSL / email / appPassword and is edited from the admin
 * panel (Setup -> Email Setup), so a changed app password must take effect
 * without a redeploy. That rules out reading process.env at boot, and it rules
 * out caching the transport forever.
 *
 * CACHING STRATEGY (serverless-aware): the container is reused between
 * invocations, so a module-scope cache is the right lifetime — it survives the
 * warm path and dies with the container. But a transport cached blindly would
 * keep authenticating with a password that was rotated in the admin panel
 * minutes ago. So the config row is re-read at most once every
 * CONFIG_TTL_MS, and the transport is rebuilt ONLY when the resulting
 * credentials actually differ (compared via a hash, so the password is not
 * duplicated into a cache key). A steady stream of sends therefore costs one
 * cheap findOne per minute and zero extra handshakes.
 */
import nodemailer from "nodemailer";
import crypto from "node:crypto";
import EmailSetup from "../models/EmailSetup.js";

/** How long an EmailSetup row is trusted before it is re-read from Mongo. */
const CONFIG_TTL_MS = 60 * 1000;

/** Cached transport + the fingerprint of the credentials that built it. */
let cachedTransport = null;
let cachedFingerprint = null;

/** Cached active EmailSetup row and when it was read. */
let cachedSetup = null;
let cachedSetupAt = 0;

/**
 * A stable, non-reversible identity for one set of credentials.
 *
 * Hashed rather than concatenated so the app password never exists as a second
 * long-lived plain string in process memory (and never lands in a heap dump or
 * a debug log of the cache key).
 *
 * @param {{host: string, port: number, SSL: boolean, email: string, appPassword: string}} cfg
 * @returns {string}
 */
const fingerprint = (cfg) =>
  crypto
    .createHash("sha256")
    .update(
      `${cfg.host}|${cfg.port}|${cfg.SSL ? 1 : 0}|${cfg.email}|${cfg.appPassword}`,
    )
    .digest("hex");

/**
 * The EmailSetup row used when a caller does not supply its own.
 *
 * `isActive: true` is the switch the admin panel toggles; the newest active row
 * wins so that adding a replacement account and deactivating the old one is a
 * two-click migration rather than a deploy.
 *
 * @param {boolean} [force] - bypass the TTL (used after resetMailTransport()).
 * @returns {Promise<object|null>} lean EmailSetup document, or null if none is configured.
 */
const getActiveSetup = async (force = false) => {
  const fresh = Date.now() - cachedSetupAt < CONFIG_TTL_MS;
  if (!force && fresh && cachedSetup) return cachedSetup;

  const setup = await EmailSetup.findOne({ isActive: true })
    .sort({ updatedAt: -1 })
    .lean();

  cachedSetup = setup || null;
  cachedSetupAt = Date.now();
  return cachedSetup;
};

/**
 * Builds — or returns the cached — nodemailer transport for one credential set.
 *
 * The Gmail branch is not cosmetic. Gmail's SMTP endpoint requires the OAuth-
 * aware `service: "gmail"` preset (it selects the right host, port and TLS
 * behaviour, and tolerates the 465/587 difference); driving it with raw
 * host/port intermittently fails the handshake for app-password logins. That
 * special case was already in otp.controller.js and is preserved verbatim here
 * so behaviour does not change with the refactor.
 *
 * @param {{host: string, port: number, SSL: boolean, email: string, appPassword: string}} cfg
 * @returns {import("nodemailer").Transporter}
 */
const transportFor = (cfg) => {
  const fp = fingerprint(cfg);
  if (cachedTransport && cachedFingerprint === fp) return cachedTransport;

  // Credentials changed (or first use) — drop the old pool before replacing it,
  // or its keep-alive sockets leak for the life of the container.
  if (cachedTransport) {
    try {
      cachedTransport.close();
    } catch {
      // A transport that cannot be closed is already unusable; nothing to do.
    }
  }

  const auth = { user: cfg.email, pass: cfg.appPassword };

  cachedTransport = String(cfg.host || "")
    .toLowerCase()
    .includes("gmail")
    ? nodemailer.createTransport({ service: "gmail", auth })
    : nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: Boolean(cfg.SSL),
        auth,
      });

  cachedFingerprint = fp;
  return cachedTransport;
};

/**
 * Forgets the cached config and transport.
 *
 * Call this after the EmailSetup row is written from the admin panel if you
 * need the change to apply immediately instead of within CONFIG_TTL_MS.
 *
 * @returns {void}
 */
export const resetMailTransport = () => {
  if (cachedTransport) {
    try {
      cachedTransport.close();
    } catch {
      // Already dead — see transportFor().
    }
  }
  cachedTransport = null;
  cachedFingerprint = null;
  cachedSetup = null;
  cachedSetupAt = 0;
};

/**
 * The address mail is sent FROM, which is also the sensible default inbox for
 * internal notifications (lead alerts): whoever owns the sending account is by
 * definition the person watching it.
 *
 * Returns null when no EmailSetup row is configured, so callers can degrade
 * instead of throwing.
 *
 * @returns {Promise<string|null>}
 */
export const getMailFromAddress = async () => {
  const setup = await getActiveSetup();
  return setup?.email || null;
};

/**
 * Sends one email.
 *
 * THROWS on failure — deliberately. A caller that must not fail because of SMTP
 * (the public lead form, for instance) wraps this in its own try/catch and logs;
 * a caller for which the email IS the feature (OTP) needs the error to surface.
 * Swallowing errors in here would take that choice away from both.
 *
 * @param {object} args
 * @param {string|string[]} args.to
 * @param {string} args.subject
 * @param {string} [args.html]
 * @param {string} [args.text]
 * @param {string} [args.cc]
 * @param {string} [args.bcc]
 * @param {string} [args.fromName] - display name; falls back to the account address.
 * @param {object} [args.setup] - an explicit EmailSetup document (e.g. the one an
 *   EmailTemplate points at via `emailFrom`). Omit to use the active row.
 * @returns {Promise<{messageId: string, accepted: string[]}>}
 */
export const sendMail = async ({
  to,
  subject,
  html,
  text,
  cc,
  bcc,
  fromName,
  setup,
}) => {
  const cfg = setup || (await getActiveSetup());

  if (!cfg?.email || !cfg?.appPassword || !cfg?.host) {
    throw new Error(
      "No usable EmailSetup found — seed or activate one (npm run seed:email)",
    );
  }
  if (!to) throw new Error("sendMail requires a recipient");

  const transporter = transportFor(cfg);

  const info = await transporter.sendMail({
    from: fromName ? `"${fromName}" <${cfg.email}>` : cfg.email,
    to,
    cc: cc || undefined,
    bcc: bcc || undefined,
    subject,
    html,
    text,
  });

  return { messageId: info.messageId, accepted: info.accepted || [] };
};

export default { sendMail, resetMailTransport, getMailFromAddress };
