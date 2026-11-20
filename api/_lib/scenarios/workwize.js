// Workwize FDE demo: a customer-onboarding agent. It reads a (fictional) client's HRIS export, checks a sandbox
// equipment catalog by country, drafts laptop orders and retrievals, and flags what needs a human.
// Everything is made up and deterministic. draft_order / schedule_retrieval enforce real rules and reject bad drafts.

const TODAY = "2026-11-30"; // sandbox "today" (Monday), fixed so runs are reproducible

const SKU = {
  MBP14: { name: "MacBook Pro 14 (M4 Pro, 24 GB)", price: 2399 },
  MBA13: { name: "MacBook Air 13 (M4, 16 GB)", price: 1399 },
  LAT7450: { name: "Dell Latitude 7450 (i7, 16 GB)", price: 1549 },
  MON27: { name: "27-inch USB-C monitor", price: 329 },
  HS: { name: "Wireless headset", price: 219 },
};

// Sandbox catalog per country. std/exp = business days to deliver; stock = units in the local warehouse;
// imp = business days when the laptop ships from a regional hub instead (null = no import route).
const CAT = {
  US: { name: "United States", std: 3, exp: 1, fee: 45, stock: { MBP14: 14, MBA13: 22, LAT7450: 9 }, imp: null },
  CA: { name: "Canada", std: 4, exp: 2, fee: 60, stock: { MBP14: 3, MBA13: 6, LAT7450: 2 }, imp: 8 },
  UK: { name: "United Kingdom", std: 3, exp: 1, fee: 40, stock: { MBP14: 5, MBA13: 8, LAT7450: 6 }, imp: null },
  DE: { name: "Germany", std: 4, exp: 2, fee: 55, stock: { MBP14: 4, MBA13: 7, LAT7450: 5 }, imp: null },
  MX: { name: "Mexico", std: 4, exp: null, fee: null, stock: { MBP14: 0, MBA13: 3, LAT7450: 4 }, imp: 9 },
  BR: { name: "Brazil", std: 6, exp: null, fee: null, stock: { MBP14: 1, MBA13: 0, LAT7450: 2 }, imp: 18 },
  CO: { name: "Colombia", std: 5, exp: null, fee: null, stock: { MBP14: 1, MBA13: 2, LAT7450: 3 }, imp: 12 },
  IN: { name: "India", std: 6, exp: 3, fee: 70, stock: { MBP14: 0, MBA13: 0, LAT7450: 4 }, imp: 15 },
  AR: { name: "Argentina", std: null, exp: null, fee: null, stock: {}, imp: 20 },
};

const CASES = {
  northwind: {
    customer: "Northwind Robotics", hq: "Austin, TX", source: "Workday export", itLead: "Dana Whitfield, IT lead",
    policy: {
      Engineering: { laptop: "MBP14", subs: ["MBA13"], acc: ["MON27"], note: "MBA13 only as a temporary device when the MBP14 cannot arrive in time" },
      Sales: { laptop: "MBA13", subs: [], acc: ["HS"] },
      Support: { laptop: "LAT7450", subs: [], acc: ["HS"] },
    },
    rows: [
      { id: "E-2101", type: "hire", name: "Maya Chen", email: "maya.chen@northwind.example", dept: "Engineering", country: "US", city: "Austin, TX", address: "1400 Lavaca St, Apt 6B, Austin, TX 78701", date: "2026-12-07" },
      { id: "E-2102", type: "hire", name: "Daniel Okafor", email: "daniel.okafor@northwind.example", dept: "Sales", country: "US", city: "Chicago, IL", address: "", date: "2026-12-14" },
      { id: "E-2103", type: "hire", name: "Sofía Ramírez", email: "sofia.ramirez@northwind.example", dept: "Engineering", country: "MX", city: "Guadalajara", address: "Av. Chapultepec 215, Col. Americana, 44160 Guadalajara, Jal.", date: "2026-12-07" },
      { id: "E-2104", type: "hire", name: "Lucas Pereira", email: "lucas.pereira@northwind.example", dept: "Support", country: "BR", city: "São Paulo", address: "Rua Augusta 1200, ap 51, 01304-001 São Paulo SP", date: "2026-12-02" },
      { id: "E-2105", type: "hire", name: "Emily Carter", email: "emily.carter@northwind.example", dept: "Sales", country: "CA", city: "Toronto, ON", address: "88 Queens Quay W, Unit 1204, Toronto ON M5J 0B8", date: "2026-12-07" },
      { id: "E-2106", type: "hire", name: "Maya Chen", email: "maya.chen@northwind.example", dept: "Engineering", country: "US", city: "Austin, TX", address: "1400 Lavaca St, Apt 6B, Austin, TX 78701", date: "2026-12-07" },
      { id: "E-1877", type: "leaver", name: "Ryan Brooks", email: "ryan.brooks@northwind.example", dept: "Sales", country: "US", city: "Denver, CO", address: "2250 Blake St, Apt 310, Denver, CO 80205", date: "2026-12-04" },
    ],
    assets: { "E-1877": [{ asset: "NW-0412", sku: "MBA13", serial: "C02XK1NWQ6" }, { asset: "NW-0413", sku: "HS", serial: "HS-77120" }] },
  },
  brightline: {
    customer: "Brightline Freight", hq: "Atlanta, GA", source: "BambooHR export", itLead: "Marcus Hale, Head of IT",
    policy: {
      Operations: { laptop: "LAT7450", subs: [], acc: ["HS"] },
      Sales: { laptop: "MBA13", subs: ["LAT7450"], acc: ["HS"], note: "LAT7450 is an approved alternative for Sales" },
      Engineering: { laptop: "MBP14", subs: [], acc: ["MON27"] },
      Finance: { laptop: "LAT7450", subs: [], acc: ["MON27"] },
    },
    rows: [
      { id: "B-311", type: "hire", name: "Hannah Wright", email: "hannah.wright@brightline.example", dept: "Operations", country: "UK", city: "Manchester", address: "14 Ancoats St, Flat 3, Manchester M4 6DE", date: "2026-12-07" },
      { id: "B-312", type: "hire", name: "Jonas Weber", email: "jonas.weber@brightline.example", dept: "Engineering", country: "DE", city: "Berlin", address: "Torstraße 140, 10119 Berlin", date: "2026-12-03" },
      { id: "B-313", type: "hire", name: "Arjun Mehta", email: "arjun.mehta@brightline.example", dept: "Sales", country: "IN", city: "Bengaluru", address: "42 Residency Rd, Shanthala Nagar, Bengaluru 560025", date: "2026-12-14" },
      { id: "B-314", type: "hire", name: "Aigerim Sadykova", email: "aigerim.sadykova@brightline.example", dept: "Operations", country: "KZ", city: "Almaty", address: "Abay Ave 52, Apt 17, Almaty 050008", date: "2026-12-14" },
      { id: "B-315", type: "hire", name: "Marcus Lee", email: "marcus.lee@brightline.example", dept: "Finance", country: "US", city: "Atlanta, GA", address: "500 Peachtree St NE, Unit 9C, Atlanta, GA 30308", date: "2026-12-07" },
      { id: "B-207", type: "leaver", name: "Oliver Grant", email: "oliver.grant@brightline.example", dept: "Operations", country: "UK", city: "Leeds", address: "7 Wellington St, Leeds LS1 4DL", date: "2026-12-09" },
      { id: "B-188", type: "leaver", name: "Rachel Kim", email: "rachel.kim@brightline.example", dept: "Sales", country: "US", city: "Seattle, WA", address: "1521 2nd Ave, Apt 1802, Seattle, WA 98101", date: "2026-12-04" },
    ],
    assets: { "B-207": [{ asset: "BF-1180", sku: "LAT7450", serial: "7HX2R93" }, { asset: "BF-1181", sku: "HS", serial: "HS-50931" }], "B-188": [] },
  },
  cobalt: {
    customer: "Cobalt & Finch Studio", hq: "Brooklyn, NY", source: "Personio export", itLead: "Priya Raman, IT & Ops lead",
    policy: {
      Design: { laptop: "MBP14", subs: [], acc: ["MON27"] },
      Accounts: { laptop: "MBA13", subs: [], acc: ["HS"] },
      Engineering: { laptop: "MBP14", subs: [], acc: ["MON27"] },
    },
    rows: [
      { id: "C-501", type: "hire", name: "Valentina Ruiz", email: "valentina.ruiz@cobaltfinch.example", dept: "Design", country: "AR", city: "Buenos Aires", address: "Av. Santa Fe 2450, 7B, C1123 CABA", date: "2026-12-14" },
      { id: "C-502", type: "hire", name: "Andrés Gómez", email: "andres.gomez@cobaltfinch.example", dept: "Accounts", country: "CO", city: "Bogotá", address: "Cra. 7 #71-21, Apto 902, Bogotá", date: "2026-12-09" },
      { id: "C-503", type: "hire", name: "Hailey Brooks", email: "hailey.brooks@cobaltfinch.example", dept: "Accounts", country: "US", city: "Portland, OR", address: "PO Box 4471, Portland, OR 97208", date: "2026-12-07" },
      { id: "C-504", type: "hire", name: "Tomás Herrera", email: "tomas.herrera@cobaltfinch.example", dept: "Engineering", country: "MX", city: "Monterrey", address: "Av. Constitución 300, Centro, 64000 Monterrey, N.L.", date: "2026-12-14" },
      { id: "C-505", type: "hire", name: "Noah Patel", email: "noah.patel@cobaltfinch.example", dept: "Engineering", country: "US", city: "New York, NY", address: "245 Grand St, Apt 4, Brooklyn, NY 11211", date: "2026-12-07" },
      { id: "C-410", type: "leaver", name: "Noah Patel", email: "noah.patel@cobaltfinch.example", dept: "Engineering (contractor)", country: "US", city: "New York, NY", address: "245 Grand St, Apt 4, Brooklyn, NY 11211", date: "2026-12-04" },
      { id: "C-388", type: "leaver", name: "Camila Souza", email: "camila.souza@cobaltfinch.example", dept: "Design", country: "BR", city: "Rio de Janeiro", address: "Rua Visconde de Pirajá 330, ap 801, 22410-002 Rio de Janeiro RJ", date: "2026-12-01" },
    ],
    assets: { "C-410": [{ asset: "CF-0077", sku: "MBP14", serial: "FVFHD2Q1P3" }], "C-388": [{ asset: "CF-0051", sku: "MBP14", serial: "FVFG81LMQ0" }, { asset: "CF-0052", sku: "MON27", serial: "MN-22817" }] },
  },
};

/* ---------- dates (UTC, business days, no holidays in the sandbox) ---------- */
const D = (s) => new Date(s + "T00:00:00Z");
const iso = (d) => d.toISOString().slice(0, 10);
const nice = (s) => D(s).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const isWk = (d) => d.getUTCDay() === 0 || d.getUTCDay() === 6;
function addBd(s, n) { const d = D(s); while (n > 0) { d.setUTCDate(d.getUTCDate() + 1); if (!isWk(d)) n--; } return iso(d); }
function prevBd(s) { const d = D(s); do d.setUTCDate(d.getUTCDate() - 1); while (isWk(d)); return iso(d); }
const validDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(D(s));

const fmtMoney = (n) => "$" + n.toLocaleString("en-US");
const S = (x, n = 80) => String(x ?? "").slice(0, n);

function lines(st) {
  // the rows table the page renders: one line per export row, with its current status
  return st.rows.map((r) => ({ id: r.id, status: st.status[r.id].s, detail: st.status[r.id].d }));
}
function board(st) { return { kind: "board", lines: lines(st), issues: st.issues }; }

export default {
  maxTurns: 12,
  maxTokens: 1800,
  system: `You are an onboarding agent built by a Forward Deployed Engineer at an IT equipment company (laptops and devices for remote teams in many countries). A new US client just sent their first HRIS export of new hires and leavers. Your job: turn it into correct equipment orders and device retrievals, and hand the client's IT lead a clean list of what needs a human decision.

How to work:
1. read_hris_export once. It also returns the client's equipment policy per department.
2. check_catalog once, with every country of the new hires. lookup_assets once, with every leaver.
3. Call draft_order for EVERY new hire with the policy laptop and standard shipping, and schedule_retrieval for EVERY leaver with the first business day after their last day, even when you suspect a problem. Call them in parallel in one turn. Do not do date math, duplicate checks or address checks yourself: the validator is the source of truth.
4. The validator may reject a draft. When rejected, read the reason. Fix it yourself only when a rule allows it: express shipping, a substitute laptop that the client's policy lists for that department, or a later pickup date. Never invent an address, a date, a device or a policy. If no allowed fix exists, call flag_for_human for that person with the concrete reason and one specific suggested action, and the owner who must decide (client IT lead, client HR, or our Operations team). Also flag any substitute device you ordered so the IT lead knows.
5. Every row must end as an order, a retrieval, or a flag (a person who appears on two rows needs both rows handled). Then call send_it_lead_summary once, and stop.
In flags and the summary, never offer an option the validator ruled out (for example express where it is not available, or a laptop the policy does not allow). Business options are fine: move the start date, provide a street address, confirm a status.
Your text is shown live to a visitor: before each batch of tool calls write ONE sentence of at most 25 words. Never write lists, line breaks, analysis or date math. After the summary is sent, write one closing sentence.`,

  init(input) {
    const id = String(input?.case || "");
    if (!CASES[id]) throw new Error("case must be northwind, brightline or cobalt");
    const c = JSON.parse(JSON.stringify(CASES[id]));
    const status = {};
    for (const r of c.rows) status[r.id] = { s: "pending", d: r.type === "hire" ? "new hire" : "leaver" };
    return { case: id, ...c, status, orders: {}, retrievals: {}, issues: [], tried: {}, fix: {}, read: false, summary: null, rejects: 0 };
  },

  prompt(st) {
    return `New client: ${st.customer} (HQ ${st.hq}). Their ${st.source} just landed (${st.rows.length} rows). Today is ${nice(TODAY)} (${TODAY}). Process it end to end.`;
  },

  tools: [
    {
      name: "read_hris_export",
      description: "Read the client's HRIS export (new hires and leavers) and their equipment policy per department.",
      input_schema: { type: "object", properties: {} },
      run(st) {
        st.read = true;
        const rows = st.rows.map((r) => `${r.id} | ${r.type} | ${r.name} | ${r.email} | ${r.dept} | ${r.country} | ${r.city} | address: ${r.address || "(empty)"} | ${r.type === "hire" ? "start" : "last day"} ${r.date} (${nice(r.date)})`);
        const pol = Object.entries(st.policy).map(([d, p]) => `${d}: ${p.laptop} (${SKU[p.laptop].name}) + ${p.acc.join(", ")}; substitutes: ${p.subs.length ? p.subs.join(", ") + (p.note ? " — " + p.note : "") : "none"}`);
        const hires = st.rows.filter((r) => r.type === "hire").length;
        return {
          result: `Export rows:\n${rows.join("\n")}\n\nEquipment policy:\n${pol.join("\n")}\nDevices must arrive by the business day before the start date. Retrieval pickup: first business day after the last day, or later.`,
          brief: `${st.rows.length} rows: ${hires} new hire${hires === 1 ? "" : "s"}, ${st.rows.length - hires} leaver${st.rows.length - hires === 1 ? "" : "s"} · policy for ${Object.keys(st.policy).length} departments`,
          card: { kind: "export", customer: st.customer, source: st.source, today: TODAY, rows: st.rows.map((r) => ({ id: r.id, type: r.type, name: r.name, dept: r.dept, country: r.country, city: r.city, date: r.date, addr: r.address ? (/po box/i.test(r.address) ? "PO box" : "ok") : "missing" })) },
        };
      },
    },
    {
      name: "check_catalog",
      description: "Check the equipment catalog for one or more countries: local stock per laptop, delivery times (business days) for standard and express, and import routes.",
      input_schema: { type: "object", properties: { countries: { type: "array", items: { type: "string" }, description: "ISO-like country codes from the export, e.g. US, MX" } }, required: ["countries"] },
      run(st, { countries }) {
        const list = [...new Set((Array.isArray(countries) ? countries : [countries]).map((c) => S(c, 4).toUpperCase()))].slice(0, 10);
        const out = list.map((c) => {
          const k = CAT[c];
          if (!k) return `${c}: not in the standard catalog. Orders need a custom quote from Operations.`;
          const stock = Object.keys(SKU).filter((s) => k.stock[s] !== undefined && !["MON27", "HS"].includes(s)).map((s) => `${s} ${k.stock[s]}`).join(", ") || "no local stock";
          return `${c} (${k.name}): ${k.std ? "local stock " + stock + "; standard " + k.std + " bd" : "no local warehouse"}; express ${k.exp ? k.exp + " bd (+" + fmtMoney(k.fee) + ")" : "not available"}; import from hub ${k.imp ? k.imp + " bd, standard only" : "n/a"}. Accessories always in stock.`;
        });
        const miss = list.filter((c) => !CAT[c]);
        return { result: out.join("\n"), brief: list.map((c) => CAT[c] ? `${c} ${CAT[c].std ? CAT[c].std + "d" : "import " + CAT[c].imp + "d"}` : `${c} not in catalog`).join(" · "), flag: miss.length > 0 };
      },
    },
    {
      name: "lookup_assets",
      description: "Look up devices currently assigned to employees in the asset register (use for leavers).",
      input_schema: { type: "object", properties: { employee_ids: { type: "array", items: { type: "string" } } }, required: ["employee_ids"] },
      run(st, { employee_ids }) {
        const ids = (Array.isArray(employee_ids) ? employee_ids : [employee_ids]).map((x) => S(x, 12)).slice(0, 10);
        const out = ids.map((id) => {
          const a = st.assets[id];
          if (a === undefined) return `${id}: no record in the asset register.`;
          if (!a.length) return `${id}: no devices assigned in the register.`;
          return `${id}: ` + a.map((x) => `${x.asset} ${SKU[x.sku].name} (serial ${x.serial})`).join("; ");
        });
        const empty = ids.some((id) => !st.assets[id] || !st.assets[id].length);
        return { result: out.join("\n"), brief: ids.map((id) => `${id}: ${st.assets[id] && st.assets[id].length ? st.assets[id].length + " device" + (st.assets[id].length > 1 ? "s" : "") : "nothing on record"}`).join(" · "), flag: empty };
      },
    },
    {
      name: "draft_order",
      description: "Draft and validate an equipment order for one new hire: the laptop SKU plus the department's accessories. Rejected drafts explain why.",
      input_schema: { type: "object", properties: { employee_id: { type: "string" }, laptop_sku: { type: "string", enum: ["MBP14", "MBA13", "LAT7450"] }, shipping: { type: "string", enum: ["standard", "express"] } }, required: ["employee_id", "laptop_sku", "shipping"] },
      run(st, { employee_id, laptop_sku, shipping }) {
        const id = S(employee_id, 12), sku = S(laptop_sku, 10), ship = shipping === "express" ? "express" : "standard";
        const r = st.rows.find((x) => x.id === id);
        const no = (why, short, fix) => {
          st.rejects++; st.tried[id] = true; st.fix[id] = fix || null;
          if (r && st.status[id].s !== "ordered") st.status[id] = { s: "rejected", d: short };
          return { result: `REJECTED ${id}: ${why}`, brief: `rejected · ${short}`, flag: true, card: board(st) };
        };
        if (!r || r.type !== "hire") return no(`${id} is not a new hire in this export.`, "not a new hire");
        if (st.orders[id]) return { result: `${id} already has order ${st.orders[id].ref}. Nothing changed.`, brief: "already ordered" };
        const dup = Object.values(st.orders).find((o) => o.email === r.email);
        if (dup) return no(`duplicate person. ${r.email} already has order ${dup.ref} under ${dup.id} (same name, same start date). Ordering again would ship two laptops.`, `duplicate of ${dup.id}`);
        const leaver = st.rows.find((x) => x.type === "leaver" && x.email === r.email);
        if (leaver) {
          const a = (st.assets[leaver.id] || []).map((x) => `${x.asset} ${x.sku}`).join(", ");
          return no(`${r.email} is also leaver ${leaver.id} (last day ${leaver.date}) and still holds ${a || "devices"}. Looks like a contractor converting to employee: shipping a new laptop and retrieving the old one may be wasted. Needs a decision before ordering.`, `same person as leaver ${leaver.id}`);
        }
        if (!r.address.trim()) return no(`no shipping address in the export for ${r.name}.`, "no shipping address");
        if (/p\.?\s*o\.?\s*box/i.test(r.address)) return no(`address is a PO box (${r.address}). Couriers do not deliver laptops to PO boxes; a street address is required.`, "PO box address");
        const k = CAT[r.country];
        if (!k) return no(`${r.country} is not in the standard catalog. Needs a custom quote from Operations before an order can exist.`, `${r.country} not in catalog`);
        const pol = st.policy[r.dept];
        if (!pol) return no(`no equipment policy for department ${r.dept}.`, "no policy");
        if (sku !== pol.laptop && !pol.subs.includes(sku)) return no(`${sku} is not allowed for ${r.dept}. Policy: ${pol.laptop}${pol.subs.length ? ", substitutes " + pol.subs.join(", ") : ", no substitutes"}.`, `${sku} not allowed for ${r.dept}`);
        const local = (k.stock[sku] || 0) > 0;
        if (!local && !k.imp) return no(`${sku} is out of stock in ${r.country} and there is no import route.`, `${sku} out of stock`);
        if (ship === "express" && (!local || !k.exp)) return no(`express is not available for ${sku} in ${r.country}${!local ? " (it ships from the import hub, standard only)" : ""}.`, "express not available");
        const days = !local ? k.imp : ship === "express" ? k.exp : k.std;
        const eta = addBd(TODAY, days), need = prevBd(r.date);
        if (eta > need) {
          const opts = [];
          if (local && ship === "standard" && k.exp && addBd(TODAY, k.exp) <= need) opts.push(`retry with shipping "express": arrives ${nice(addBd(TODAY, k.exp))} (+${fmtMoney(k.fee)})`);
          for (const s of pol.subs) { const loc = (k.stock[s] || 0) > 0; const e = addBd(TODAY, loc ? k.std : k.imp || 999); if (s !== sku && (loc || k.imp) && e <= need) opts.push(`retry with laptop_sku "${s}" (policy substitute): arrives ${nice(e)}`); }
          return no(`too late. ${sku} via ${!local ? "import (" + k.imp + " bd)" : ship + " (" + days + " bd)"} arrives ${nice(eta)}, but ${r.name} starts ${nice(r.date)} and it must arrive by ${nice(need)}. ${opts.length ? "Allowed fix: " + opts.join("; or ") + "." : "No shipping option or policy substitute makes it in time: needs a human decision. Earliest start date this order supports: " + nice(addBd(eta, 1)) + "."}`, `arrives ${nice(eta)}, needed by ${nice(need)}`, opts.length ? opts.join("; or ") : null);
        }
        if (local) k.stock[sku]--;
        const ref = "WO-" + (4100 + Object.keys(st.orders).length + 1);
        const items = [sku, ...pol.acc];
        const value = items.reduce((t, s) => t + SKU[s].price, 0) + (ship === "express" ? k.fee : 0);
        const sub = sku !== pol.laptop;
        st.orders[id] = { ref, id, email: r.email, sku, items, ship, eta, value, sub };
        st.status[id] = { s: "ordered", d: `${ref} · ${SKU[sku].name}${pol.acc.length ? " + " + pol.acc.map((s) => SKU[s].name.replace(/^W/, "w")).join(", ") : ""} · ${local ? "local stock" : "import"} · ${ship} · arrives ${nice(eta)}${sub ? " · substitute" : ""}` };
        return {
          result: `OK ${ref} for ${r.name}: ${items.join(" + ")}, ${local ? "from local stock" : "via import hub"}, ${ship}, arrives ${nice(eta)} (needed by ${nice(need)}). Value ${fmtMoney(value)}.${sub ? " Substitute device: now flag_for_human this employee to the client IT lead so they can approve a swap later." : ""}`,
          brief: `${ref} · ${sku}${sub ? " (substitute)" : ""} · ${ship} · arrives ${nice(eta)}`,
          card: board(st),
        };
      },
    },
    {
      name: "schedule_retrieval",
      description: "Schedule and validate a device retrieval for one leaver: a return box and courier pickup at their address, devices go back to the nearest warehouse for data wipe.",
      input_schema: { type: "object", properties: { employee_id: { type: "string" }, asset_ids: { type: "array", items: { type: "string" } }, pickup_date: { type: "string", description: "YYYY-MM-DD" } }, required: ["employee_id", "asset_ids", "pickup_date"] },
      run(st, { employee_id, asset_ids, pickup_date }) {
        const id = S(employee_id, 12), date = S(pickup_date, 10);
        const r = st.rows.find((x) => x.id === id);
        const no = (why, short, fix) => {
          st.rejects++; st.tried[id] = true; st.fix[id] = fix || null;
          if (r && st.status[id].s !== "retrieval") st.status[id] = { s: "rejected", d: short };
          return { result: `REJECTED ${id}: ${why}`, brief: `rejected · ${short}`, flag: true, card: board(st) };
        };
        if (!r || r.type !== "leaver") return no(`${id} is not a leaver in this export.`, "not a leaver");
        if (st.retrievals[id]) return { result: `${id} already has retrieval ${st.retrievals[id].ref}.`, brief: "already scheduled" };
        const held = st.assets[id] || [];
        if (!held.length) return no(`the asset register shows no devices for ${r.name}. Nothing to retrieve on record: the device may have been bought outside the platform. Needs the serial number from the client.`, "no devices on record");
        const ids = (Array.isArray(asset_ids) ? asset_ids : [asset_ids]).map((x) => S(x, 12));
        const bad = ids.filter((a) => !held.some((h) => h.asset === a));
        if (bad.length || !ids.length) return no(`asset ids ${bad.join(", ") || "(none)"} are not assigned to ${id}. Assigned: ${held.map((h) => h.asset).join(", ")}.`, "wrong asset ids");
        const hire = st.rows.find((x) => x.type === "hire" && x.email === r.email);
        if (hire) return no(`${r.email} also starts as new hire ${hire.id} on ${hire.date}. Retrieving the laptop now and shipping a new one may be wasted. Needs a decision first.`, `same person as new hire ${hire.id}`);
        if (!validDate(date)) return no(`pickup_date must be YYYY-MM-DD.`, "bad date");
        const earliest = [addBd(r.date, 1), addBd(TODAY, 2)].sort().pop();
        if (date < earliest) return no(`pickup ${nice(date)} is too early. ${r.name}'s last day is ${nice(r.date)}. Allowed fix: retry with pickup_date "${earliest}" (${nice(earliest)}).`, `pickup too early, earliest ${nice(earliest)}`, `retry with pickup_date "${earliest}"`);
        if (isWk(D(date))) return no(`${nice(date)} is a weekend. Couriers pick up on business days.`, "weekend pickup");
        const ref = "RT-" + (7300 + Object.keys(st.retrievals).length + 1);
        const missing = held.filter((h) => !ids.includes(h.asset));
        st.retrievals[id] = { ref, ids, date };
        st.status[id] = { s: "retrieval", d: `${ref} · ${ids.length} device${ids.length > 1 ? "s" : ""} (${held.filter((h) => ids.includes(h.asset)).map((h) => h.sku).join(", ")}) · box ships now · pickup ${nice(date)} · wipe at warehouse` };
        return {
          result: `OK ${ref} for ${r.name}: return box ships today, courier pickup ${nice(date)}, ${ids.join(", ")} to the nearest warehouse for data wipe.${missing.length ? " Not included: " + missing.map((m) => m.asset).join(", ") + "." : ""}`,
          brief: `${ref} · ${ids.length} device${ids.length > 1 ? "s" : ""} · pickup ${nice(date)}`,
          card: board(st),
        };
      },
    },
    {
      name: "flag_for_human",
      description: "Record an issue the agent must not decide alone. Shown to the client's IT lead with the reason and a suggested action.",
      input_schema: { type: "object", properties: {
        employee_id: { type: "string" },
        issue: { type: "string", description: "short title, max 60 chars" },
        why: { type: "string", description: "the concrete reason, from tool results, max 200 chars" },
        suggested_action: { type: "string", description: "one specific action, max 160 chars" },
        owner: { type: "string", enum: ["client IT lead", "client HR", "Operations"] },
      }, required: ["employee_id", "issue", "why", "suggested_action", "owner"] },
      run(st, i) {
        const id = S(i.employee_id, 12);
        const r = st.rows.find((x) => x.id === id);
        if (!r) return { result: `Unknown employee ${id}.`, brief: "unknown employee", flag: true };
        const s0 = st.status[id].s;
        if (!st.tried[id] && s0 !== "ordered") return { result: `Not recorded: call ${r.type === "hire" ? "draft_order" : "schedule_retrieval"} for ${id} first. The validator decides what is a problem.` };
        if (st.fix[id] && s0 !== "ordered" && s0 !== "retrieval") return { result: `Not recorded: the validator listed an allowed fix for ${id} that you have not applied: ${st.fix[id]}. Apply it instead of escalating.` };
        const item = { id, name: r.name, issue: S(i.issue, 70), why: S(i.why, 240), action: S(i.suggested_action, 200), owner: S(i.owner, 20) };
        const k = st.issues.findIndex((x) => x.id === id && x.issue === item.issue);
        if (k >= 0) st.issues[k] = item; else st.issues.push(item);
        const s = st.status[id].s;
        if (s !== "ordered" && s !== "retrieval") st.status[id] = { s: "human", d: `${item.issue} · owner: ${item.owner}` };
        return { result: `Flagged ${id} for ${item.owner}.`, brief: `${item.owner} · ${item.issue}`, flag: true, card: board(st) };
      },
    },
    {
      name: "send_it_lead_summary",
      description: "Final step: send the client's IT lead a short summary of the run. Call once, after every row is handled.",
      silent: true,
      input_schema: { type: "object", properties: {
        subject: { type: "string", description: "max 80 chars" },
        message: { type: "string", description: "plain text email, max 600 chars. One line on what was ordered and scheduled (they see the table, do not list every order), then the numbered decisions needed from them" },
      }, required: ["subject", "message"] },
      run(st, i) {
        const open = st.rows.filter((r) => !["ordered", "retrieval", "human"].includes(st.status[r.id].s));
        if (open.length) {
          return { result: `Not sent: rows still unresolved: ${open.map((r) => r.id).join(", ")}. Each needs an order, a retrieval or a flag.`, flag: true };
        }
        const subs = Object.values(st.orders).filter((o) => o.sub && !st.issues.some((x) => x.id === o.id));
        if (subs.length) return { result: `Not sent: substitute device ordered for ${subs.map((o) => o.id).join(", ")} but not flagged to the client IT lead. Flag it first.`, flag: true };
        const o = Object.values(st.orders);
        st.summary = { kind: "summary", to: st.itLead, customer: st.customer, subject: S(i.subject, 90), message: S(i.message, 1200),
          orders: o.length, retrievals: Object.keys(st.retrievals).length, issues: st.issues.length,
          value: o.reduce((t, x) => t + x.value, 0), rejects: st.rejects };
        return { result: "Sent.", card: st.summary };
      },
    },
  ],
};
