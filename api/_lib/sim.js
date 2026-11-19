// A small simulated Supabase project: files, tables, RLS policies, indexes, slow-query log.
// Tools read and change this state, so a fix the agent applies really changes what the next check returns.
import { TEMPLATES } from "./templates.js";

export function newProject(id) {
  const t = TEMPLATES[id];
  if (!t) return null;
  return { id, ...JSON.parse(JSON.stringify(t)) };
}

const clip = (s, n = 4000) => (s.length > n ? s.slice(0, n) + "\n…(truncated)" : s);
const fmt = (n) => n.toLocaleString("en-US");

// ---------- policy logic ----------
// A policy scopes rows only when it ties them to the caller (auth.uid() compared to a column or a lookup).
function scopes(expr) {
  const e = expr.toLowerCase();
  if (!e.includes("auth.uid()")) return false;
  if (/auth\.uid\(\)\s+is\s+not\s+null/.test(e) && !/=\s*auth\.uid\(\)|auth\.uid\(\)\s*=/.test(e.replace(/auth\.uid\(\)\s+is\s+not\s+null/g, ""))) return false;
  return true;
}
function exposure(p, table, cmd, as) {
  const tb = p.tables[table];
  if (!tb.rls) return { leaked: as === "anon" || as === "other_user" ? tb.rows : 0, why: "RLS is disabled on this table, so the API serves every row to anyone holding the anon key." };
  const pol = tb.policies.filter((x) => x.cmd === cmd || x.cmd === "all");
  if (!pol.length) return { leaked: 0, why: `RLS on, no ${cmd} policy: access denied (safe, but the app cannot ${cmd} either).` };
  let anonBlocked = false;
  for (const x of pol) {
    const e = x.expr.toLowerCase();
    if (/using\s*\(\s*true\s*\)/.test(e)) return { leaked: tb.rows, why: `Policy "${x.name}" is USING (true): every row is visible to every caller.` };
    if (!scopes(x.expr)) {
      if (as === "anon" && /authenticated|auth\.uid\(\)\s+is\s+not\s+null/.test(e)) { anonBlocked = true; continue; }
      return { leaked: tb.rows, why: `Policy "${x.name}" (${x.expr}) only checks that the caller is signed in, not that the row belongs to them.` };
    }
  }
  if (anonBlocked) return { leaked: 0, why: "A logged-out visitor is blocked, but the policy only checks for a signed-in user. Test as other_user too." };
  return { leaked: 0, why: "Every matching policy ties rows to auth.uid(); other users get nothing." };
}

// ---------- secrets in the client bundle ----------
const isClientFile = (path, src) =>
  path.startsWith("src/") && !/^src\/(app\/api|server|pages\/api)\//.test(path) && !/server-only|['"]use server['"]/.test(src);
function bundleFindings(p) {
  const out = [];
  const env = {};
  for (const [path, src] of Object.entries(p.files))
    if (/(^|\/)\.env/.test(path))
      for (const line of src.split("\n")) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m) env[m[1]] = { path, value: m[2] };
      }
  for (const [name, v] of Object.entries(env)) {
    const secret = /service_role|SERVICE_ROLE/.test(name + v.value) || /^sk-/.test(v.value);
    if (secret && /^(VITE_|NEXT_PUBLIC_)/.test(name))
      out.push(`${name} (${v.path}) has a public prefix, so the bundler inlines its value into the JavaScript every visitor downloads.`);
  }
  for (const [path, src] of Object.entries(p.files)) {
    if (!isClientFile(path, src)) continue;
    for (const m of src.matchAll(/(?:import\.meta\.env|process\.env)\.([A-Z0-9_]+)/g)) {
      const v = env[m[1]];
      if (v && (/service_role|SERVICE_ROLE/.test(m[1] + v.value) || /^sk-/.test(v.value)))
        out.push(`${path} reads ${m[1]} in browser code.`);
    }
  }
  return [...new Set(out)];
}

// ---------- query plans ----------
function hasIndex(p, q) {
  const tb = p.tables[q.table];
  return tb.indexes.some((ix) => {
    if (q.kind === "vector") return /hnsw|ivfflat/.test(ix.method) && ix.cols[0] === q.cols[0];
    if (q.kind === "trgm") return ix.method === "gin" && ix.cols[0] === q.cols[0] && ix.trgm;
    return ix.method === "btree" && ix.cols[0] === q.cols[0];
  });
}
function plan(p, q) {
  const tb = p.tables[q.table];
  if (hasIndex(p, q)) {
    const ix = tb.indexes.find((i) => i.cols[0] === q.cols[0]);
    return { ms: q.fastMs, text: `Index Scan using ${ix.name} on ${q.table}  (rows≈${q.kind === "vector" ? 5 : 40})\nExecution Time: ${q.fastMs} ms` };
  }
  const how = q.kind === "vector" ? `Sort  (Sort Key: (embedding <=> $1))\n  ->  Seq Scan on ${q.table}  (rows=${fmt(tb.rows)})  -- exact distance on every row`
    : q.kind === "trgm" ? `Seq Scan on ${q.table}  (rows=${fmt(tb.rows)})\n  Filter: (title ~~* '%…%')  -- a leading wildcard cannot use a btree index`
    : `Seq Scan on ${q.table}  (rows=${fmt(tb.rows)})\n  Filter: (${q.cols.join(" / ")})  -- no index starts with ${q.cols[0]}`;
  return { ms: q.slowMs, text: `${how}\nExecution Time: ${q.slowMs} ms` };
}

// ---------- page request trace (N+1 detection from the code) ----------
function tracePage(p, route) {
  const path = p.pages[route];
  if (!path) return `Unknown route. Routes: ${Object.keys(p.pages).join(", ")}`;
  const src = p.files[path] || "";
  const loops = (src.match(/for\s*\(const[\s\S]*?\{[\s\S]*?\.from\(/g) || []).length;
  const calls = (src.match(/\.from\(|\.rpc\(/g) || []).length;
  if (loops) {
    const n = 1 + 20 + 20 * 3;
    return `${route}: ${n} sequential HTTP requests to the Data API for one page load (1 for orders, then one per order and one per item). p50 load 2.4 s.`;
  }
  const q = p.queries.find((x) => x.page === route);
  const ms = q ? (hasIndex(p, q) ? q.fastMs : q.slowMs) : 30;
  return `${route}: ${Math.max(1, calls)} request(s) to the Data API, slowest DB time ${ms} ms.`;
}

// ---------- migrations ----------
function applyMigration(p, sql) {
  const done = [], refused = [];
  if (/\b(drop\s+table|truncate|delete\s+from|drop\s+schema|alter\s+role|grant\s+all)\b/i.test(sql))
    return "Refused: this demo only accepts additive fixes (RLS, policies, indexes, functions). No drops, deletes or grants.";
  for (const raw of sql.split(/;\s*(?=\n|$)/)) {
    const s = raw.trim();
    if (!s || /^--/.test(s)) continue;
    let m;
    if ((m = s.match(/alter\s+table\s+(?:public\.)?(\w+)\s+enable\s+row\s+level\s+security/i))) {
      if (!p.tables[m[1]]) { refused.push(`unknown table ${m[1]}`); continue; }
      p.tables[m[1]].rls = true; done.push(`RLS enabled on ${m[1]}`);
    } else if ((m = s.match(/drop\s+policy\s+(?:if\s+exists\s+)?"([^"]+)"\s+on\s+(?:public\.)?(\w+)/i))) {
      const tb = p.tables[m[2]];
      if (!tb) { refused.push(`unknown table ${m[2]}`); continue; }
      const before = tb.policies.length;
      tb.policies = tb.policies.filter((x) => x.name !== m[1]);
      done.push(before !== tb.policies.length ? `dropped policy "${m[1]}" on ${m[2]}` : `no policy "${m[1]}" on ${m[2]} (nothing to drop)`);
    } else if ((m = s.match(/create\s+policy\s+"([^"]+)"\s+on\s+(?:public\.)?(\w+)\s+(?:as\s+\w+\s+)?for\s+(\w+)\s+(?:to\s+\w+\s+)?([\s\S]*)$/i))) {
      const tb = p.tables[m[2]];
      if (!tb) { refused.push(`unknown table ${m[2]}`); continue; }
      tb.policies = tb.policies.filter((x) => x.name !== m[1]);
      tb.policies.push({ name: m[1], cmd: m[3].toLowerCase(), expr: m[4].replace(/\s+/g, " ").trim() });
      done.push(`created policy "${m[1]}" on ${m[2]} for ${m[3].toLowerCase()}`);
    } else if ((m = s.match(/create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(\w+)?\s*on\s+(?:public\.)?(\w+)\s*(?:using\s+(\w+)\s*)?\(([\s\S]+)\)/i))) {
      const tb = p.tables[m[2]];
      if (!tb) { refused.push(`unknown table ${m[2]}`); continue; }
      const method = (m[3] || "btree").toLowerCase();
      const cols = m[4].split(",").map((c) => c.trim().split(/\s+/)[0].replace(/[()"]/g, ""));
      const name = m[1] || `${m[2]}_${cols.join("_")}_idx`;
      tb.indexes.push({ name, method, cols, trgm: /gin_trgm_ops/i.test(m[4]) });
      done.push(`index ${name} on ${m[2]} using ${method} (${m[4].trim()})`);
    } else if ((m = s.match(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?(\w+)/i))) {
      const f = p.functions[m[1]];
      if (!f) { refused.push(`unknown function ${m[1]}`); continue; }
      f.securityDefiner = /security\s+definer/i.test(s);
      f.filtersUser = /auth\.uid\(\)/i.test(s);
      done.push(`replaced function ${m[1]} (${f.securityDefiner ? "security definer" : "security invoker"}${f.filtersUser ? ", filters by auth.uid()" : ""})`);
    } else if (/^create\s+extension/i.test(s)) {
      done.push(s.replace(/\s+/g, " "));
    } else refused.push(`not supported in this sandbox: ${s.slice(0, 80)}`);
  }
  return [done.length ? "Applied:\n- " + done.join("\n- ") : "Nothing applied.", refused.length ? "Skipped:\n- " + refused.join("\n- ") : ""].filter(Boolean).join("\n");
}

// ---------- tool definitions ----------
const S = (props, req = Object.keys(props)) => ({ type: "object", properties: props, required: req });
const str = (d) => ({ type: "string", description: d });

export const TOOL_DEFS = {
  list_files: { description: "List every file in the customer's project folder.", input_schema: S({}) },
  read_file: { description: "Read one file from the project folder.", input_schema: S({ path: str("Exact path from list_files") }) },
  inspect_table: { description: "Live database facts for one table: row count, whether RLS is enabled, current policies, indexes.", input_schema: S({ table: str("Table name") }) },
  top_queries: { description: "pg_stat_statements: the most expensive queries in production, with calls per day and mean time.", input_schema: S({}) },
  explain_query: { description: "EXPLAIN ANALYZE for one query from top_queries, against the live data.", input_schema: S({ query_id: str("Id like q1") }) },
  test_access: {
    description: "Penetration test through the public Data API with the anon key: try to read (select) or change (update) rows that belong to another user/tenant. Use rpc:<function_name> as table to test an RPC.",
    input_schema: S({ table: str("Table name, or rpc:<function> for an RPC"), action: { type: "string", enum: ["select", "update"] }, as: { type: "string", enum: ["anon", "other_user"], description: "anon = logged-out visitor with the anon key; other_user = signed-in user from another account/tenant" } }),
  },
  scan_client_bundle: { description: "Scan what ships to the browser (client code + public env vars) for secrets.", input_schema: S({}) },
  trace_page: { description: "Load one page of the app and count the requests it makes to Supabase, with timings.", input_schema: S({ route: str("Route like /orders") }) },
  report_finding: {
    description: "Report one confirmed problem to the customer. Call once per distinct problem, right after you have evidence from a tool.",
    input_schema: S({
      severity: { type: "string", enum: ["critical", "high", "medium"] },
      title: str("Short title, under 70 characters"),
      evidence: str("What the tool showed, with numbers"),
      impact: str("What it means for the customer's users or business, one or two sentences"),
      fix: str("The exact fix: SQL migration or code change"),
    }),
  },
  apply_migration: { description: "Run a SQL migration on the project database (RLS, policies, indexes, functions).", input_schema: S({ sql: str("SQL statements separated by semicolons") }) },
  edit_file: { description: "Replace an exact snippet in a project file (to fix code or env files).", input_schema: S({ path: str("File path"), find: str("Exact text to replace"), replace: str("New text") }) },
  create_file: { description: "Create a new file in the project (for example a server route).", input_schema: S({ path: str("File path"), content: str("File content") }) },
  report_fix: {
    description: "Report one fix as done, with the before/after measured by a tool after applying it.",
    input_schema: S({ title: str("Which problem"), before: str("Measured before"), after: str("Measured after, from a tool call made after the fix"), verified: { type: "boolean" } }),
  },
};

export function runTool(p, name, input = {}) {
  switch (name) {
    case "list_files":
      return Object.keys(p.files).map((f) => `${f}  (${p.files[f].split("\n").length} lines)`).join("\n");
    case "read_file": {
      const f = p.files[input.path];
      return f == null ? `No such file. Files: ${Object.keys(p.files).join(", ")}` : clip(f);
    }
    case "inspect_table": {
      const tb = p.tables[input.table];
      if (!tb) return `No such table. Tables: ${Object.keys(p.tables).join(", ")}`;
      return [`table ${input.table}: ${fmt(tb.rows)} rows · RLS ${tb.rls ? "ENABLED" : "DISABLED"}`,
        `policies: ${tb.policies.length ? tb.policies.map((x) => `\n  - "${x.name}" for ${x.cmd} ${x.expr}`).join("") : "none"}`,
        `indexes: ${tb.indexes.map((i) => `\n  - ${i.name} ${i.method} (${i.cols.join(", ")}${i.trgm ? " gin_trgm_ops" : ""})`).join("")}`].join("\n");
    }
    case "top_queries":
      return p.queries.map((q) => { const pl = plan(p, q); return `${q.id}  ${fmt(q.callsPerDay)} calls/day  mean ${pl.ms} ms  page ${q.page}\n    ${q.sql}`; }).join("\n");
    case "explain_query": {
      const q = p.queries.find((x) => x.id === input.query_id);
      return q ? `${q.sql}\n\n${plan(p, q).text}` : "Unknown query id. Call top_queries first.";
    }
    case "test_access": {
      const t = String(input.table || "");
      if (t.startsWith("rpc:")) {
        const f = p.functions[t.slice(4)];
        if (!f) return `No such function. Functions: ${Object.keys(p.functions).join(", ") || "none"}`;
        const tb = p.tables[f.table];
        if (f.securityDefiner && !f.filtersUser) return `LEAK: as ${input.as}, ${t} returned rows owned by other users. It is SECURITY DEFINER, so it runs as the owner and skips the RLS on ${f.table}, and it has no user filter (${fmt(tb.rows)} rows reachable).`;
        if (input.as === "anon" && !f.filtersUser && !f.securityDefiner) return `OK: ${t} runs as the caller (security invoker), RLS on ${f.table} applies. anon got 0 rows.`;
        return `OK: ${t} returned only the caller's own rows (0 rows from other users).`;
      }
      const tb = p.tables[t];
      if (!tb) return `No such table. Tables: ${Object.keys(p.tables).join(", ")}`;
      const bundle = bundleFindings(p).filter((x) => /SERVICE_ROLE/.test(x));
      if (bundle.length) return `LEAK: the browser bundle carries the service_role key, which bypasses RLS on every table. With it, ${input.as} can ${input.action} all ${fmt(tb.rows)} rows of ${t}, whatever the policies say.`;
      const r = exposure(p, t, input.action === "update" ? "update" : "select", input.as);
      return r.leaked ? `LEAK: as ${input.as}, ${input.action} on ${t} reached ${fmt(r.leaked)} rows that are not theirs. ${r.why}` : `OK: as ${input.as}, ${input.action} on ${t} reached 0 rows of other users. ${r.why}`;
    }
    case "scan_client_bundle": {
      const f = bundleFindings(p);
      return f.length ? "SECRETS EXPOSED:\n- " + f.join("\n- ") : "Clean: no secret keys reach the browser. Only the anon key and URL are public.";
    }
    case "trace_page":
      return tracePage(p, input.route);
    case "apply_migration":
      return applyMigration(p, String(input.sql || ""));
    case "edit_file": {
      const f = p.files[input.path];
      if (f == null) return "No such file.";
      if (!input.find || !f.includes(input.find)) return "The 'find' text is not in the file. Read the file and copy the snippet exactly.";
      p.files[input.path] = f.replace(input.find, input.replace ?? "");
      return `Edited ${input.path}.`;
    }
    case "create_file":
      if (!input.path || p.files[input.path] != null) return "File exists or no path given.";
      p.files[input.path] = clip(String(input.content || ""), 3000);
      return `Created ${input.path}.`;
    case "report_finding":
    case "report_fix":
      return "Recorded.";
    default:
      return "Unknown tool.";
  }
}

// One-line summary of a tool result for the visible trace.
export function brief(name, out) {
  const first = out.split("\n")[0];
  if (name === "read_file") return `${out.split("\n").length} lines`;
  if (name === "list_files") return `${out.split("\n").length} files`;
  if (name === "top_queries") return `${out.split("\n").filter((l) => /^q\d/.test(l)).length} queries`;
  if (name === "scan_client_bundle") return out.startsWith("SECRETS") ? "SECRETS EXPOSED: " + out.split("\n")[1].replace(/^- /, "").slice(0, 140) : first;
  if (name === "explain_query") return (out.match(/Execution Time: [\d.]+ ms/) || [""])[0] + (/Seq Scan/.test(out) ? " · Seq Scan" : /Index Scan/.test(out) ? " · Index Scan" : "");
  return first.slice(0, 160);
}
