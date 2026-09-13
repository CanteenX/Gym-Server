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
 *   home      seeded: hero, about, cta
 *   programs  seeded: header, cta
 *   contact   seeded: header, form, cta
 *   header    seeded by this change: brand, cta
 *   footer    seeded by this change: brand, explore, branches, legal
 *   social    seeded by this change: one row per network
 *   about     RESERVED — "about" is a section on the home page today
 *             (home/about), not a page of its own, so an /cms/about screen
 *             opens empty until somebody creates about/* rows
 *   pricing   RESERVED — the pricing table is a SiteItem list ("plans"), and
 *             the page carries no prose block of its own yet
 *   faqs      RESERVED — same shape as pricing
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
});

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
 */
export const CMS_COLLECTION_MENUS = Object.freeze({
  programs: "/cms/programs",
  plans: "/cms/pricing",
  faqs: "/cms/faqs",
  trainers: "/cms/trainers",
  testimonials: "/cms/testimonials",
  classes: "/cms/classes",
  transformations: "/cms/transformations",
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
 * Every leaf menuUrl the tree defines, for the seed and for tests that assert
 * the tree and the two maps have not drifted apart.
 *
 * @returns {string[]}
 */
export const cmsLeafMenuUrls = () =>
  CMS_MENU_TREE.flatMap((row) =>
    row.children ? row.children.map((child) => child.menuUrl) : [row.menuUrl],
  ).filter((url) => url !== "#");
