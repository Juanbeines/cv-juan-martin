// Three fictional customer projects, each with real-world mistakes planted on purpose.
// The agent never sees this file directly: it explores the project through the tools in sim.js.

export const TEMPLATES = {
  "clinic-booking": {
    label: "clinic-booking",
    blurb: "Appointment app for 40 clinics, built with an AI app builder over a weekend. Vite + React + supabase-js.",
    complaint: "The agenda page got really slow, and a receptionist says she once saw patients from another clinic.",
    files: {
      "README.md": `# clinic-booking
Online booking for private clinics. Each clinic only manages its own patients and agenda.
Stack: Vite + React, supabase-js, Supabase Postgres. Deployed as a static site.
Roles: receptionist, doctor (profiles.role). Every staff user belongs to one clinic (profiles.clinic_id).
`,
      ".env": `VITE_SUPABASE_URL=https://xyzclinic.supabase.co
# anon key gave "permission denied" on patients, the service key fixed it
VITE_SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.demo_not_a_real_key
`,
      "supabase/migrations/001_init.sql": `create table clinics (
  id uuid primary key default gen_random_uuid(),
  name text not null
);

create table profiles (
  id uuid primary key references auth.users(id),
  clinic_id uuid not null references clinics(id),
  role text not null check (role in ('receptionist','doctor'))
);

create table patients (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id),
  full_name text not null,
  national_id text,
  phone text,
  clinical_notes text
);
-- TODO: RLS for patients (was blocking the app)

create table appointments (
  id bigint generated always as identity primary key,
  clinic_id uuid not null references clinics(id),
  patient_id uuid not null references patients(id),
  doctor_id uuid not null references profiles(id),
  starts_at timestamptz not null,
  status text not null default 'booked'
);

alter table clinics enable row level security;
create policy "staff read own clinic" on clinics for select
  using (id = (select clinic_id from profiles where id = auth.uid()));

alter table profiles enable row level security;
create policy "read own profile" on profiles for select using (id = auth.uid());

alter table appointments enable row level security;
create policy "read appointments" on appointments for select using (true);
create policy "staff write appointments" on appointments for insert
  with check (clinic_id = (select clinic_id from profiles where id = auth.uid()));
`,
      "src/lib/supabase.ts": `import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY
)
`,
      "src/pages/Agenda.tsx": `import { supabase } from '../lib/supabase'

export async function loadAgenda(doctorId: string, from: string, to: string) {
  const { data } = await supabase
    .from('appointments')
    .select('id, starts_at, status, patients(full_name, phone)')
    .eq('doctor_id', doctorId)
    .gte('starts_at', from)
    .lt('starts_at', to)
    .order('starts_at')
  return data
}
`,
      "src/pages/Patients.tsx": `import { supabase } from '../lib/supabase'

export async function searchPatients(clinicId: string, q: string) {
  const { data } = await supabase.from('patients')
    .select('id, full_name, phone')
    .eq('clinic_id', clinicId)
    .ilike('full_name', q + '%')
    .limit(20)
  return data
}
`,
    },
    tables: {
      clinics: { rows: 40, rls: true, owner: "clinic", indexes: [{ name: "clinics_pkey", method: "btree", cols: ["id"] }] },
      profiles: { rows: 610, rls: true, owner: "self", indexes: [{ name: "profiles_pkey", method: "btree", cols: ["id"] }] },
      patients: { rows: 312000, rls: false, owner: "clinic", indexes: [{ name: "patients_pkey", method: "btree", cols: ["id"] }, { name: "patients_clinic_name_idx", method: "btree", cols: ["clinic_id", "full_name"] }] },
      appointments: { rows: 2140000, rls: true, owner: "clinic", indexes: [{ name: "appointments_pkey", method: "btree", cols: ["id"] }] },
    },
    queries: [
      { id: "q1", sql: "select ... from appointments where doctor_id = $1 and starts_at >= $2 and starts_at < $3 order by starts_at", table: "appointments", kind: "btree", cols: ["doctor_id", "starts_at"], callsPerDay: 3800, slowMs: 1420, fastMs: 3.8, page: "/agenda" },
      { id: "q2", sql: "select id, full_name, phone from patients where clinic_id = $1 and full_name ilike $2 limit 20", table: "patients", kind: "btree", cols: ["clinic_id", "full_name"], callsPerDay: 2100, slowMs: 610, fastMs: 1.9, page: "/patients" },
    ],
    functions: {},
    pages: { "/agenda": "src/pages/Agenda.tsx", "/patients": "src/pages/Patients.tsx" },
  },

  marketplace: {
    label: "marketplace",
    blurb: "Two-sided marketplace: 9,000 sellers, buyers, orders. Next.js + supabase-js.",
    complaint: "Search takes seconds, the orders page feels sluggish, and a seller reported that their prices changed by themselves.",
    files: {
      "README.md": `# marketplace
Sellers list products, buyers place orders. Next.js App Router, supabase-js on the client, Supabase Postgres.
products.seller_id is the auth user id of the seller. Product catalog is public.
`,
      ".env.local": `NEXT_PUBLIC_SUPABASE_URL=https://mkt.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.demo_anon
`,
      "supabase/migrations/001_init.sql": `create table products (
  id bigint generated always as identity primary key,
  seller_id uuid not null references auth.users(id),
  title text not null,
  price_cents int not null check (price_cents >= 0),
  stock int not null default 0
);
create index products_seller_idx on products (seller_id);

create table orders (
  id bigint generated always as identity primary key,
  buyer_id uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
create index orders_buyer_idx on orders (buyer_id, created_at desc);

create table order_items (
  id bigint generated always as identity primary key,
  order_id bigint not null references orders(id) on delete cascade,
  product_id bigint not null references products(id),
  qty int not null
);

alter table products enable row level security;
create policy "catalog is public" on products for select using (true);
create policy "sellers manage products" on products for update
  using (auth.role() = 'authenticated');

alter table orders enable row level security;
create policy "buyers read own orders" on orders for select using (buyer_id = auth.uid());

alter table order_items enable row level security;
create policy "buyers read own items" on order_items for select
  using (exists (select 1 from orders o where o.id = order_id and o.buyer_id = auth.uid()));
`,
      "src/lib/supabase.ts": `import { createBrowserClient } from '@supabase/ssr'
export const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
`,
      "src/app/search/page.tsx": `'use client'
import { supabase } from '@/lib/supabase'

export async function search(q: string) {
  const { data } = await supabase.from('products')
    .select('id, title, price_cents')
    .ilike('title', \`%\${q}%\`)
    .limit(24)
  return data
}
`,
      "src/app/orders/page.tsx": `'use client'
import { supabase } from '@/lib/supabase'

export async function loadOrders(userId: string) {
  const { data: orders } = await supabase.from('orders')
    .select('id, created_at').eq('buyer_id', userId)
    .order('created_at', { ascending: false }).limit(20)

  const result = []
  for (const order of orders ?? []) {
    const { data: items } = await supabase.from('order_items')
      .select('qty, product_id').eq('order_id', order.id)
    for (const item of items ?? []) {
      const { data: product } = await supabase.from('products')
        .select('title, price_cents').eq('id', item.product_id).single()
      result.push({ order, item, product })
    }
  }
  return result
}
`,
      "src/app/seller/products/actions.ts": `'use client'
import { supabase } from '@/lib/supabase'

export async function updatePrice(productId: number, priceCents: number) {
  return supabase.from('products').update({ price_cents: priceCents }).eq('id', productId)
}
`,
    },
    tables: {
      products: { rows: 824000, rls: true, owner: "seller_id", indexes: [{ name: "products_pkey", method: "btree", cols: ["id"] }, { name: "products_seller_idx", method: "btree", cols: ["seller_id"] }] },
      orders: { rows: 1930000, rls: true, owner: "buyer_id", indexes: [{ name: "orders_pkey", method: "btree", cols: ["id"] }, { name: "orders_buyer_idx", method: "btree", cols: ["buyer_id", "created_at"] }] },
      order_items: { rows: 5420000, rls: true, owner: "via orders", indexes: [{ name: "order_items_pkey", method: "btree", cols: ["id"] }] },
    },
    queries: [
      { id: "q1", sql: "select id, title, price_cents from products where title ilike '%' || $1 || '%' limit 24", table: "products", kind: "trgm", cols: ["title"], callsPerDay: 41000, slowMs: 1650, fastMs: 17, page: "/search" },
      { id: "q2", sql: "select qty, product_id from order_items where order_id = $1", table: "order_items", kind: "btree", cols: ["order_id"], callsPerDay: 96000, slowMs: 380, fastMs: 0.4, page: "/orders" },
    ],
    functions: {},
    pages: { "/search": "src/app/search/page.tsx", "/orders": "src/app/orders/page.tsx" },
  },

  "ai-assistant": {
    label: "ai-assistant",
    blurb: "AI assistant with memory: users upload notes, chat over them with RAG. Next.js + pgvector.",
    complaint: "Answers take 3+ seconds to start, and one user said the bot quoted a document she never uploaded.",
    files: {
      "README.md": `# ai-assistant
Chat with your own notes. Each user uploads documents; we embed them (1536 dims) and retrieve with pgvector.
Next.js App Router. Retrieval runs through the match_documents RPC from the browser.
`,
      ".env.local": `NEXT_PUBLIC_SUPABASE_URL=https://aiapp.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.demo_anon
NEXT_PUBLIC_LLM_API_KEY=sk-live-demo-0000-not-a-real-key
`,
      "supabase/migrations/001_init.sql": `create extension if not exists vector;

create table documents (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id),
  content text not null,
  embedding vector(1536) not null
);

create table messages (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id),
  conversation_id uuid not null,
  role text not null,
  content text not null,
  created_at timestamptz default now()
);
create index messages_conv_idx on messages (conversation_id, created_at);

alter table documents enable row level security;
create policy "own documents" on documents for select using (user_id = auth.uid());

alter table messages enable row level security;
create policy "read messages" on messages for select using (auth.uid() is not null);
create policy "write own messages" on messages for insert with check (user_id = auth.uid());

create or replace function match_documents(query_embedding vector(1536), match_count int default 5)
returns table (id bigint, content text, similarity float)
language sql stable security definer
as $$
  select id, content, 1 - (embedding <=> query_embedding) as similarity
  from documents
  order by embedding <=> query_embedding
  limit match_count;
$$;
`,
      "src/lib/supabase.ts": `import { createBrowserClient } from '@supabase/ssr'
export const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
`,
      "src/app/chat/useChat.ts": `'use client'
import { supabase } from '@/lib/supabase'
import { embed, complete } from '@/lib/llm'

export async function ask(question: string) {
  const embedding = await embed(question)
  const { data: docs } = await supabase.rpc('match_documents', { query_embedding: embedding, match_count: 5 })
  return complete(question, docs ?? [])
}
`,
      "src/lib/llm.ts": `'use client'
const KEY = process.env.NEXT_PUBLIC_LLM_API_KEY

export async function embed(text: string) {
  const r = await fetch('https://llm-provider.example/v1/embeddings', {
    method: 'POST', headers: { Authorization: \`Bearer \${KEY}\` }, body: JSON.stringify({ input: text }) })
  return (await r.json()).embedding
}

export async function complete(question: string, docs: { content: string }[]) {
  const r = await fetch('https://llm-provider.example/v1/chat', {
    method: 'POST', headers: { Authorization: \`Bearer \${KEY}\` },
    body: JSON.stringify({ question, context: docs.map(d => d.content) }) })
  return (await r.json()).answer
}
`,
    },
    tables: {
      documents: { rows: 418000, rls: true, owner: "user_id", indexes: [{ name: "documents_pkey", method: "btree", cols: ["id"] }] },
      messages: { rows: 3120000, rls: true, owner: "user_id", indexes: [{ name: "messages_pkey", method: "btree", cols: ["id"] }, { name: "messages_conv_idx", method: "btree", cols: ["conversation_id", "created_at"] }] },
    },
    queries: [
      { id: "q1", sql: "select * from match_documents($1, 5)  -- order by embedding <=> $1 limit 5", table: "documents", kind: "vector", cols: ["embedding"], callsPerDay: 22000, slowMs: 2870, fastMs: 21, page: "/chat" },
    ],
    functions: { match_documents: { table: "documents", securityDefiner: true, filtersUser: false } },
    pages: { "/chat": "src/app/chat/useChat.ts" },
  },
};

// Seed the initial policy list from each migration, so the sim and the SQL the agent reads always agree.
for (const t of Object.values(TEMPLATES)) {
  for (const tb of Object.values(t.tables)) tb.policies = [];
  const sql = Object.entries(t.files).filter(([p]) => p.endsWith(".sql")).map(([, s]) => s).join("\n");
  for (const m of sql.matchAll(/create policy\s+"([^"]+)"\s+on\s+(?:public\.)?(\w+)\s+for\s+(\w+)\s+([\s\S]*?);/gi)) {
    const tb = t.tables[m[2]];
    if (tb) tb.policies.push({ name: m[1], cmd: m[3].toLowerCase(), expr: m[4].replace(/\s+/g, " ").trim() });
  }
}
