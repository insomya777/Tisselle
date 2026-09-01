-- ============================================
-- VERNIS — Booking system schema (Supabase / Postgres)
-- ============================================

create extension if not exists "pgcrypto";

-- ---------- Services you offer ----------
create table services (
  id text primary key,              -- e.g. 'gel', 'classic'
  name text not null,
  duration_minutes int not null,
  price_cents int not null,
  color text,                       -- for the swatch UI
  active boolean not null default true
);

insert into services (id, name, duration_minutes, price_cents, color) values
  ('classic', 'Manucure classique', 30, 2500, '#e7c3ca'),
  ('gel', 'Semi-permanent', 45, 3500, '#8c3b54'),
  ('art', 'Nail art', 60, 4800, '#b08d57'),
  ('pedi', 'Pédicure', 45, 3800, '#a9b79a'),
  ('ext', 'Pose / extensions', 75, 5500, '#5b4a63');

-- ---------- Recurring weekly hours ----------
-- Your normal week. weekday: 0=Sunday ... 6=Saturday.
-- Only add a row for days you're actually open — no row means closed.
create table availability_rules (
  id uuid primary key default gen_random_uuid(),
  weekday int not null check (weekday between 0 and 6),
  start_time time not null,
  end_time time not null,
  slot_minutes int not null default 30,
  unique (weekday)
);

-- Example: open Tue–Sat 18:30–21:00 on weeknights, wider on Saturday
insert into availability_rules (weekday, start_time, end_time, slot_minutes) values
  (2, '18:30', '21:00', 30),  -- Tuesday
  (3, '18:30', '21:00', 30),  -- Wednesday
  (4, '18:30', '21:00', 30),  -- Thursday
  (5, '18:00', '21:30', 30),  -- Friday
  (6, '10:00', '18:00', 30);  -- Saturday

-- ---------- One-off overrides ----------
-- Close a normally-open day (holiday, sick day), open extra hours, or
-- shorten a day because work ran late.
create table availability_overrides (
  id uuid primary key default gen_random_uuid(),
  date date not null unique,
  is_closed boolean not null default false,
  start_time time,             -- null + is_closed=false means "use normal hours" is NOT used here;
  end_time time,                -- always specify both if is_closed=false
  note text
);

-- ---------- Appointments ----------
create table appointments (
  id uuid primary key default gen_random_uuid(),
  service_id text not null references services(id),
  client_name text not null,
  client_phone text not null,
  client_email text,
  appointment_date date not null,
  start_time time not null,
  status text not null default 'confirmed'
    check (status in ('confirmed','cancelled','completed')),
  reference text unique not null,
  created_at timestamptz not null default now()
);

-- Hard stop at the database level: two confirmed bookings can never
-- share the same date + time, even under concurrent requests.
create unique index unique_confirmed_slot
  on appointments (appointment_date, start_time)
  where status = 'confirmed';

-- ---------- Row Level Security ----------
alter table services enable row level security;
alter table availability_rules enable row level security;
alter table availability_overrides enable row level security;
alter table appointments enable row level security;

-- Public (anon) can read services + availability, and can INSERT appointments
-- (i.e. book), but cannot read other people's appointments or edit hours.
create policy "public read services" on services for select using (active = true);
create policy "public read availability rules" on availability_rules for select using (true);
create policy "public read availability overrides" on availability_overrides for select using (true);
create policy "public can book" on appointments for insert with check (true);

-- Only you (authenticated as the salon owner) can read/manage appointments
-- and edit your hours. Adjust the role check to match how you log in
-- (Supabase Auth: e.g. auth.uid() = 'your-user-id', or a custom claim).
create policy "owner reads appointments" on appointments for select
  using (auth.role() = 'authenticated');
create policy "owner updates appointments" on appointments for update
  using (auth.role() = 'authenticated');
create policy "owner manages hours" on availability_rules for all
  using (auth.role() = 'authenticated');
create policy "owner manages overrides" on availability_overrides for all
  using (auth.role() = 'authenticated');

-- ---------- Public slot-checking, without exposing client details ----------
-- Anonymous visitors need to know which times are taken so the picker can
-- grey them out — but they must never see who booked them (name/phone/email).
-- This function returns only the time, nothing else, and runs with elevated
-- rights (security definer) so it can read appointments even though the
-- public has no direct SELECT policy on that table.
create or replace function get_taken_slots(p_date date)
returns table(start_time time)
language sql
security definer
set search_path = public
as $$
  select start_time from appointments
  where appointment_date = p_date and status = 'confirmed';
$$;

grant execute on function get_taken_slots(date) to anon;
