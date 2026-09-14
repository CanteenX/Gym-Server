/**
 * The CMS menu tree, and the one mapping that decides which permission a CMS
 * write is checked against.
 *
 * WHY THIS FILE EXISTS AT ALL — the failure it prevents.
 * The admin sidebar is moving from a single `/website-pages` screen with a tab
 * strip to one screen per page (`/cms/faqs`, `/cms/pricing`, …). The client
 * side gates a route on a MenuMaster row resolved BY URL; the server gates the
 * save on `checkPermission(menuUrl, action)`, also BY URL. If the two ever name
 * a different row, a staff member granted only `/cms/faqs` sails through the
 * client check, opens the editor, types, presses Save and gets a 403 — the
 * worst of both worlds, because the panel has already promised them the screen.
 *
 * So the mapping from a CONTENT KEY (SiteContent.pageKey, SiteItem.collectionKey)
 * to a MENU URL lives here, exactly once, and both halves of the server import
 * it: scripts/seedCmsMenus.js creates the rows from CMS_MENU_TREE, and
 * middlewares/cmsPermission.js checks against the URLs resolved here. They
 * cannot drift, because there is only one list.
 *
 * NOTE FOR THE ADMIN PANEL: these menuUrl strings must stay byte-identical to
 * the admin panel's route paths. That is the join key both sides match on, and
 * changing one without the other silently locks staff out of a screen that is
 * still in their sidebar.
 */

/** The MenuGroupMaster row every menu below hangs off. */
export const CMS_GROUP_NAME = "CMS";

/**
 * The legacy single-screen permission, and — deliberately — the "ALL CMS PAGES"
 * grant from here on.
 *
 * It is seeded (scripts/seedWebsiteMenus.js), it is already granted to whoever
 * the owner has given website access to, and it is referenced from the admin
 * panel's empty-state copy. Removing it would revoke, silently, every grant
 * that works today.
 *
 * DECISION, and it is the whole backward-compatibility story:
 * `/website-pages` is checked as a FALLBACK on every CMS write. Holding it for
 * an action authorises that action on EVERY page and every list. Holding a
 * per-page row (`/cms/faqs`) authorises only that page. A role can therefore be
 * given FAQ editing without pricing — which is the point of the restructure —
 * while every role that exists today keeps working unchanged, and keeps working
 * even BEFORE scripts/seedCmsMenus.js has been run (an unseeded `/cms/*` row
 * simply is not found, and the fallback carries the request).
 */
export const CMS_FALLBACK_MENU_URL = "/website-pages";

/**
 * SiteContent.pageKey → menu URL.
 *
 * Not every key here has rows today; the ones that do not are RESERVED so that
 * the day the owner adds prose to that page, its permission is already the
 * right one:
 *   home      seeded: hero, about, cta, seo
 *   programs  seeded: header, cta, seo
 *   contact   seeded: header, form, cta, seo
 *   header    seeded by this change: brand, cta
 *   footer    seeded by this change: brand, explore, branches, legal
 *   social    seeded by this change: one row per network
 *   about     RESERVED, AND THE REVALIDATION MAPPING IS A DECISION, NOT AN
 *             ACCIDENT (docs/todo.md item 1/3, checked 2026-09-14):
 *             "about" is a SECTION on the home page today (`home/about`,
 *             seeded and live), not a page of its own — an /cms/about screen
 *             opens empty until somebody creates `about/*` rows. Two
 *             consequences follow, on the two sides that own them:
 *               - THIS SERVER just passes `pageKey` through to
 *                 services/siteRevalidate.js verbatim, for both cases —
 *                 editing the live `home/about` section revalidates with
 *                 `{ pageKey: "home" }` (the page that actually renders it),
 *                 and editing a future standalone `about/*` row would
 *                 revalidate with `{ pageKey: "about" }` unchanged.
 *               - Gym-frontend/src/app/internal/revalidate/route.ts owns what
 *                 a bare `{ pageKey: "about" }` resolves to on the public
 *                 site, and maps it to `"/"` there, explicitly and with its
 *                 own comment — not silently, and not this server's call to
 *                 make, since the server has no page-to-route table at all.
 *             scripts/tests/cmsReservedKeys.test.mjs pins the server half:
 *             that editing `home/about` revalidates `"home"`, i.e. the page a
 *             visitor actually sees today.
 *   pricing   RESERVED — the pricing table is a SiteItem list ("plans"), and
 *             the page carries no prose block of its own yet
 *   faqs      RESERVED — same shape as pricing
 *   site      seeded by this change: identity, location — the brand facts
 *             (name, tagline, bio, city, region, country) that
 *             Gym-frontend/src/lib/site.ts `site` held hardcoded and that
 *             thirteen components read. They are their own page rather than
 *             more `header`/`footer` rows because they are not chrome: the
 *             header renders a wordmark and the footer a copyright line, both
 *             of which are already editable there, while these are the facts
 *             those strings are ABOUT and are also what the JSON-LD publishes.
 */
export const CMS_PAGE_MENUS = Object.freeze({
  home: "/cms/home",
  about: "/cms/about",
  programs: "/cms/programs",
  pricing: "/cms/pricing",
  faqs: "/cms/faqs",
  contact: "/cms/contact",
  header: "/cms/header",
  footer: "/cms/footer",
  social: "/cms/social",
  site: "/cms/site",
});

/**
 * THE RESERVED sectionKey THAT DRIVES META TITLE/DESCRIPTION, FORMALISED
 * (docs/todo.md item 2/4, was "undocumented" — checked 2026-09-14).
 *
 * A `SiteContent` row with `pageKey: <home|programs|contact>` and
 * `sectionKey: SEO_FALLBACK_SECTION_KEY` is not ordinary block copy: it is a
 * FALLBACK SEO SOURCE, read directly by Gym-frontend
 * (`src/lib/seo.ts:11-31`, `buildPageMetadata()`) beneath the page-wise
 * `SeoMeta` manager (`/seo-manager`) and above the constants shipped in each
 * page file. The precedence is all-or-nothing between the two CMS layers —
 * SeoMeta wins completely the moment either of its fields is set, so a page
 * can never take its title from one editor and its description from the
 * other — but never between a CMS layer and the shipped copy, which is
 * always the floor.
 *
 * THE TWO FIELDS THAT CARRY THE CONTRACT, on that row specifically:
 *   title -> fallback <title> / og:title
 *   body  -> fallback meta description / og:description
 * (`subtitle` is NOT part of this contract — an easy field to reach for by
 * name and the wrong one.) Both are ordinary `SiteContent.EDITABLE_FIELDS`
 * (controllers/v1/siteContent.controller.js), so nothing server-side treats
 * this row specially — the entire contract lives in the sectionKey string and
 * the two field names agreeing with what Gym-frontend reads. Renaming
 * `title`/`body` there, or renaming this constant, breaks the fallback with
 * NO error on this side: the site just quietly stops offering a
 * title/description for whichever pages still rely on it.
 * scripts/tests/cmsReservedKeys.test.mjs pins all three (the key string, and
 * that both field names still exist on EDITABLE_FIELDS).
 *
 * Known live usage (checked 2026-09-14): 0 `sectionKey: "seo"` rows exist —
 * every marketing route already has its own `SeoMeta` row, so the fallback is
 * dead in practice but is NOT retired here; that is a separate, owner-level
 * removal decision (docs/todo.md, "Open — needs the owner"), not a defect.
 */
export const SEO_FALLBACK_SECTION_KEY = "seo";

/**
 * SiteItem.collectionKey → menu URL.
 *
 * Two of these are not identity mappings and that is deliberate:
 *   plans → /cms/pricing   the collection is named for the records ("plans"),
 *                          the screen is named for what the owner calls it
 *                          ("Pricing"). The owner's word wins in the sidebar.
 *   programs, faqs         share a URL with the SiteContent page of the same
 *                          name, so "edit the Programs page" is ONE permission
 *                          covering both the page's header copy and the six
 *                          cards on it. Splitting them would produce a staff
 *                          member who can edit the heading above a card but not
 *                          the card — which is not a distinction anyone asked
 *                          for.
 *
 * `transformations` was ABSENT until it was given a screen of its own. It was
 * left out of the original twelve routes and therefore fell back to
 * CMS_FALLBACK_MENU_URL, which meant editing the before/after gallery required
 * the all-pages grant — the one thing this restructure exists to avoid. It now
 * has `/cms/transformations` here AND a row in CMS_MENU_TREE below: a mapping
 * without a tree row would resolve to a menu that the seed never creates, and
 * checkPermission would silently fall through to the fallback anyway. The two
 * always move together, which is what the drift test in
 * scripts/tests/cmsPermission.test.mjs pins.
 *
 * THE FIVE CHROME LISTS BELOW ARE IDENTITY MAPPINGS — collectionKey === the
 * last path segment — and that is a deliberate departure from `plans →
 * /cms/pricing`. `plans` earned its rename because the owner already calls that
 * screen "Pricing"; there is no established vocabulary for these five yet, and
 * an identity mapping is the one shape a second person cannot get wrong when
 * they add the matching route in Gym-Admin. The sidebar LABEL still says
 * whatever reads best ("Navigation", "Background Media") — a menuName may
 * differ from its URL, a URL may not differ from the admin route.
 */
export const CMS_COLLECTION_MENUS = Object.freeze({
  programs: "/cms/programs",
  plans: "/cms/pricing",
  faqs: "/cms/faqs",
  trainers: "/cms/trainers",
  testimonials: "/cms/testimonials",
  classes: "/cms/classes",
  transformations: "/cms/transformations",
  stats: "/cms/stats",
  marquee: "/cms/marquee",
  navlinks: "/cms/navlinks",
  branches: "/cms/branches",
  media: "/cms/media",
});

/**
 * SiteNotice.kind -> menu URL.
 *
 * A THIRD MAP RATHER THAN MORE ENTRIES IN THE TWO ABOVE, because the join key
 * is a different field: the CMS maps above key on a CONTENT key
 * (SiteContent.pageKey, SiteItem.collectionKey), and a notice has neither — it
 * has a `kind`. Folding "ANNOUNCEMENT" into CMS_PAGE_MENUS would mean
 * menuUrlForPageKey() answering for a value that is not a pageKey, which is how
 * a lookup starts returning confident nonsense.
 *
 * THE TWO SCREENS ARE SEPARATE ON PURPOSE, and this is the permission the
 * restructure exists to make grantable. "Tell members the gym is shut on
 * Thursday" and "run a 20%-off campaign on the home page" are different jobs
 * with different blast radii: the first is operational and somebody at the desk
 * should be able to do it today; the second is marketing and changes what the
 * gym charges. One shared /cms/notices row would make the desk staffer who can
 * post a closure also able to publish a discount.
 *
 * KEYS ARE THE STORED ENUM VALUES, UPPERCASE, matching models/SiteNotice.js.
 * normalizeKey() lowercases, so the lookup helper uppercases instead — see
 * menuUrlForNoticeKind.
 */
export const CMS_NOTICE_MENUS = Object.freeze({
  ANNOUNCEMENT: "/cms/announcements",
  BANNER: "/cms/banners",
});

/**
 * The sidebar tree scripts/seedCmsMenus.js builds, modelled on the reference
 * panel: flat pages first, the repeating lists grouped under one parent, then
 * the site chrome.
 *
 * `Content Management` is a PARENT row — `menuUrl: "#"`, `isParent: true`, its
 * children pointing back at it via `parentMenu`. It is not a screen and
 * checkPermission is never called with "#", so it authorises nothing; it exists
 * to give the six lists one collapsible home instead of six top-level entries.
 * Because "#" is shared with other parent rows elsewhere (scripts/seedMenus.js
 * seeds "Faq Master" the same way), the seed matches a parent on
 * (menuName, menuGroup) rather than on menuUrl.
 */
export const CMS_MENU_TREE = Object.freeze([
  { menuName: "Home", menuUrl: "/cms/home", sequence: 1, icon: "ri-home-4-line" },
  {
    menuName: "About",
    menuUrl: "/cms/about",
    sequence: 2,
    icon: "ri-information-line",
  },
  {
    menuName: "Contact Us",
    menuUrl: "/cms/contact",
    sequence: 3,
    icon: "ri-customer-service-2-line",
  },
  {
    menuName: "Content Management",
    menuUrl: "#",
    sequence: 4,
    icon: "ri-stack-line",
    isParent: true,
    children: [
      {
        menuName: "Programs",
        menuUrl: "/cms/programs",
        sequence: 1,
        icon: "ri-boxing-line",
      },
      {
        menuName: "Pricing",
        menuUrl: "/cms/pricing",
        sequence: 2,
        icon: "ri-price-tag-3-line",
      },
      {
        menuName: "FAQs",
        menuUrl: "/cms/faqs",
        sequence: 3,
        icon: "ri-question-answer-line",
      },
      {
        menuName: "Trainers",
        menuUrl: "/cms/trainers",
        sequence: 4,
        icon: "ri-user-star-line",
      },
      {
        menuName: "Testimonials",
        menuUrl: "/cms/testimonials",
        sequence: 5,
        icon: "ri-chat-quote-line",
      },
      {
        menuName: "Classes",
        menuUrl: "/cms/classes",
        sequence: 6,
        icon: "ri-calendar-2-line",
      },
      {
        // Last in sequence rather than slotted in alphabetically: the six rows
        // above have been in the owner's sidebar since the restructure shipped,
        // and renumbering them would move every entry under the cursor for a
        // screen that is new. An added row goes at the end.
        menuName: "Transformations",
        menuUrl: "/cms/transformations",
        sequence: 7,
        icon: "ri-gallery-line",
      },
      // ---- SITE CHROME LISTS ----
      // Appended at 8-12 for the same reason Transformations went last: the
      // seven rows above have been in the owner's sidebar since the
      // restructure shipped, and renumbering them would move every entry under
      // the cursor for screens that are new.
      {
        menuName: "Stats",
        menuUrl: "/cms/stats",
        sequence: 8,
        icon: "ri-bar-chart-2-line",
      },
      {
        menuName: "Marquee",
        menuUrl: "/cms/marquee",
        sequence: 9,
        icon: "ri-text-spacing",
      },
      {
        // Labelled "Navigation" but routed at /cms/navlinks: the URL matches the
        // collectionKey exactly (see CMS_COLLECTION_MENUS), the label is what
        // the owner would look for in a sidebar.
        menuName: "Navigation",
        menuUrl: "/cms/navlinks",
        sequence: 10,
        icon: "ri-links-line",
      },
      {
        // NOT the Branch Master at /branch-master. That screen edits the
        // operational branch records whose `name` is stored on every member,
        // trainer and transaction; this one edits the two branch CARDS on the
        // public site — phone, hours, blurb, map link. Two different sidebar
        // entries reading "Branches" is a little awkward, which is why this one
        // says "Branch Cards".
        menuName: "Branch Cards",
        menuUrl: "/cms/branches",
        sequence: 11,
        icon: "ri-map-pin-2-line",
      },
      {
        menuName: "Background Media",
        menuUrl: "/cms/media",
        sequence: 12,
        icon: "ri-film-line",
      },
    ],
  },
  {
    menuName: "Header",
    menuUrl: "/cms/header",
    sequence: 5,
    icon: "ri-layout-top-line",
  },
  {
    menuName: "Footer",
    menuUrl: "/cms/footer",
    sequence: 6,
    icon: "ri-layout-bottom-line",
  },
  {
    menuName: "Social & Media",
    menuUrl: "/cms/social",
    sequence: 7,
    icon: "ri-instagram-line",
  },
  {
    // The brand facts themselves — name, tagline, bio, city, region, country.
    // Top-level rather than under Content Management because it is a form, not
    // a list, and it sits next to Header / Footer / Social as the fourth piece
    // of "the site as a whole" rather than "a page of it".
    menuName: "Site Identity",
    menuUrl: "/cms/site",
    sequence: 8,
    icon: "ri-shield-star-line",
  },
  {
    /**
     * TOP-LEVEL, not under Content Management, and appended at 9-10 rather than
     * slotted in — the same two rules every addition to this tree has followed.
     *
     * Top-level because these are site-WIDE, like Header / Footer / Social /
     * Site Identity: an announcement is true on every page, and a banner is
     * placed across pages rather than belonging to one. Content Management
     * holds the lists that ARE a page's content (the programme cards, the
     * pricing table), and neither of these is that.
     *
     * Appended rather than inserted because the eight rows above have been in
     * the owner's sidebar since the restructure shipped, and renumbering them
     * would move every entry under the cursor for screens that are new.
     */
    menuName: "Announcements",
    menuUrl: "/cms/announcements",
    sequence: 9,
    icon: "ri-megaphone-line",
  },
  {
    // Its own row rather than a tab on Announcements: see CMS_NOTICE_MENUS for
    // why posting a closure and publishing a discount are separate grants.
    menuName: "Banners",
    menuUrl: "/cms/banners",
    sequence: 10,
    icon: "ri-slideshow-line",
  },
]);

/** Trim-and-lowercase, matching how both controllers normalise their keys. */
const normalizeKey = (value) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

/**
 * Which menu permission governs a SiteContent row.
 *
 * An unmapped pageKey — a page invented in the data after this file shipped,
 * which SiteContent.pageKey explicitly allows — resolves to the all-pages
 * permission rather than to nothing. "No mapping" must never mean "no check".
 *
 * @param {unknown} pageKey SiteContent.pageKey
 * @returns {string} a menuUrl checkPermission can resolve
 */
export const menuUrlForPageKey = (pageKey) =>
  CMS_PAGE_MENUS[normalizeKey(pageKey)] || CMS_FALLBACK_MENU_URL;

/**
 * Which menu permission governs a SiteItem row. Same fallback rule as above.
 *
 * @param {unknown} collectionKey SiteItem.collectionKey
 * @returns {string} a menuUrl checkPermission can resolve
 */
export const menuUrlForCollectionKey = (collectionKey) =>
  CMS_COLLECTION_MENUS[normalizeKey(collectionKey)] || CMS_FALLBACK_MENU_URL;

/**
 * Which menu permission governs a SiteNotice row.
 *
 * SAME FALLBACK RULE as the two above — an unrecognised kind takes the
 * all-pages grant, because "no mapping" must never mean "no check". In practice
 * `kind` is a closed enum the schema rejects, so the fallback here is reached
 * only by a request that names a kind that does not exist, which the controller
 * will 400 on anyway.
 *
 * UPPERCASES rather than using normalizeKey(): the stored enum values are
 * SCREAMING_SNAKE and the map is keyed on them verbatim, so lowercasing would
 * miss every row.
 *
 * @param {unknown} kind SiteNotice.kind
 * @returns {string} a menuUrl checkPermission can resolve
 */
export const menuUrlForNoticeKind = (kind) => {
  const key = typeof kind === "string" ? kind.trim().toUpperCase() : "";
  return CMS_NOTICE_MENUS[key] || CMS_FALLBACK_MENU_URL;
};

/**
 * Every leaf menuUrl the tree defines, for the seed and for tests that assert
 * the tree and the two maps have not drifted apart.
 *
 * @returns {string[]}
 */
export const cmsLeafMenuUrls = () =>
  CMS_MENU_TREE.flatMap((row) =>
    row.children ? row.children.map((child) => child.menuUrl) : [row.menuUrl],
  ).filter((url) => url !== "#");
