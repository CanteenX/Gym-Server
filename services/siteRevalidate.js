/**
 * Tells the public site to rebuild a marketing page after a CMS write.
 *
 * The whole point of Phase 1 is that an admin edit is live in seconds without
 * a rebuild. The site runs on ISR, so the rendered HTML is cached at the edge
 * until something invalidates it - and that something is this call.
 *
 * WHY THE SERVER AND NOT THE ADMIN PANEL: the admin is a Vite SPA running in a
 * browser. `revalidatePath` is a Next server function it cannot call, and the
 * shared secret would be sitting in page source the moment it tried. So the
 * write path that already has the secret makes the call.
 *
 * WHY AWAITED: on Vercel the function is frozen the instant the response is
 * flushed, so a detached promise never resolves and the page silently stays
 * stale. It is awaited behind a short timeout with every error swallowed - a
 * failed revalidation must never fail the save. Worst case the edit is still
 * saved and the page catches up when the ISR window expires.
 */

/** Hard ceiling on how long a save may wait for the site to be told. */
const REVALIDATE_TIMEOUT_MS = 4000;

const siteOrigin = () =>
  (process.env.PUBLIC_SITE_ORIGIN || "").trim().replace(/\/+$/, "");

/**
 * @param {object} body `{ pageKey }`, `{ paths: [...] }`, or `{}` for all
 *   marketing routes - which is the right default for an advert, since adverts
 *   are placed across pages rather than owned by one.
 * @returns {Promise<boolean>} whether the site confirmed the refresh
 */
export const revalidateSite = async (body = {}) => {
  const origin = siteOrigin();
  const secret = process.env.REVALIDATE_SECRET;

  // Not configured is a normal state locally and in any environment without a
  // public site in front of it. Say so once, at debug volume, and move on.
  if (!origin || !secret) {
    console.log(
      "[revalidate] skipped — PUBLIC_SITE_ORIGIN or REVALIDATE_SECRET is unset",
    );
    return false;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REVALIDATE_TIMEOUT_MS);

  try {
    const res = await fetch(`${origin}/internal/revalidate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-revalidate-secret": secret,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(
        `[revalidate] ${origin} answered ${res.status} for ${JSON.stringify(body)}`,
      );
      return false;
    }
    return true;
  } catch (error) {
    // Includes the abort. The edit is already saved; this is best-effort.
    console.warn(`[revalidate] failed: ${error?.message || error}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
};
