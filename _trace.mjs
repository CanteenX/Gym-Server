/**
 * Throwaway: replays the exact client sequence for the Vasna branch admin and
 * prints the real shapes at each step, so the failing layer is visible rather
 * than inferred. Delete after use.
 */
const BASE = "http://localhost:7002/api/v1";

const r = await fetch(`${BASE}/auth/company/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    email: "midcityvasna@gmail.com",
    password: "123456",
    locationConsent: true,
    ipConsent: true,
  }),
});
const lj = await r.json();
console.log("LOGIN:", r.status, lj.isOk ? "OK" : lj.message);
if (!lj.isOk) process.exit(0);
const ck = (r.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
const G = async (p) => {
  const x = await fetch(`${BASE}${p}`, { headers: { Cookie: ck } });
  let j = {};
  try { j = await x.json(); } catch { /* non-JSON */ }
  return { s: x.status, j };
};

const me = await G("/auth/me");
const roleId = me.j.data?.roleId;
console.log("\nauth/me:", me.s, "roleId =", roleId);

const er = await G(`/employee-roles/${roleId}`);
console.log("\nemployee-roles RAW:");
console.log("  status:", er.s);
console.log("  typeof data:", Array.isArray(er.j.data) ? "ARRAY" : typeof er.j.data);
console.log("  data keys:", er.j.data ? Object.keys(er.j.data).slice(0, 8).join(", ") : "(null)");
const roles = Array.isArray(er.j.data) ? er.j.data[0]?.roles : er.j.data?.roles;
console.log("  roles length:", (roles || []).length);
console.log("  first row:", JSON.stringify((roles || [])[0]));

const mn = await G("/menus/by-groups");
const groups = mn.j.data || [];
console.log("\nmenus/by-groups:", mn.s, "groups =", groups.length);
for (const g of groups) {
  console.log(`  "${g.groupName}" isLink=${g.isLink} groupId=${g.groupId} menus=${(g.menus || []).length}`);
}

// Exactly the client's filter.
const filterItems = (items, rs) =>
  (items || []).filter((m) => {
    const ok = rs.some((x) => x.menuId === m.id && x.read);
    if (m.children?.length) {
      m.children = filterItems(m.children, rs);
      return ok || m.children.length > 0;
    }
    return ok;
  });

console.log("\nPER-GROUP FILTER TRACE:");
for (const g of groups) {
  if (g.isLink) {
    const hit = (roles || []).some((x) => x.menuGroupId === g.groupId && x.read);
    console.log(`  "${g.groupName}" isLink -> groupId match: ${hit}`);
    continue;
  }
  const kept = filterItems(g.menus || [], roles || []);
  console.log(`  "${g.groupName}" ${(g.menus || []).length} menus -> ${kept.length} kept`);
  if ((g.menus || []).length && !kept.length) {
    const sample = g.menus[0];
    console.log(`      sample menu.id=${sample.id} (${typeof sample.id})`);
    const anyMatch = (roles || []).find((x) => String(x.menuId) === String(sample.id));
    console.log(`      matching row exists: ${Boolean(anyMatch)} read=${anyMatch?.read}`);
  }
}
