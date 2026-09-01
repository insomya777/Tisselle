// booking-client.js
// Frontend logic: reads your hours from Supabase, computes open slots for
// a given date, and books an appointment safely (DB unique index blocks
// double-booking even if two people click "confirm" at the same instant).

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

// --- Services -----------------------------------------------------------

export async function getServices() {
  const { data, error } = await supabase
    .from('services')
    .select('*')
    .eq('active', true);
  if (error) throw error;
  return data;
}

// --- Availability ---------------------------------------------------------

// Returns { open: boolean, start: 'HH:MM', end: 'HH:MM', slotMinutes } for one date,
// resolving weekly rules + any one-off override for that date.
export async function getDayWindow(dateStr) {
  const weekday = new Date(dateStr + 'T00:00:00').getDay();

  const { data: override } = await supabase
    .from('availability_overrides')
    .select('*')
    .eq('date', dateStr)
    .maybeSingle();

  if (override) {
    if (override.is_closed) return { open: false };
    return {
      open: true,
      start: override.start_time,
      end: override.end_time,
      slotMinutes: 30,
    };
  }

  const { data: rule } = await supabase
    .from('availability_rules')
    .select('*')
    .eq('weekday', weekday)
    .maybeSingle();

  if (!rule) return { open: false }; // no rule for this weekday = closed
  return {
    open: true,
    start: rule.start_time,
    end: rule.end_time,
    slotMinutes: rule.slot_minutes,
  };
}

// Returns every bookable time ('HH:MM') for a date, minus slots already taken.
export async function getAvailableSlots(dateStr) {
  const window = await getDayWindow(dateStr);
  if (!window.open) return [];

  const slots = [];
  let [h, m] = window.start.split(':').map(Number);
  const [endH, endM] = window.end.split(':').map(Number);
  while (h < endH || (h === endH && m < endM)) {
    slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    m += window.slotMinutes;
    if (m >= 60) { h += 1; m -= 60; }
  }

  const { data: booked, error } = await supabase
    .from('appointments')
    .select('start_time')
    .eq('appointment_date', dateStr)
    .eq('status', 'confirmed');
  if (error) throw error;

  const takenTimes = new Set(booked.map(b => b.start_time.slice(0, 5)));
  return slots.map(t => ({ time: t, available: !takenTimes.has(t) }));
}

// --- Booking --------------------------------------------------------------

function makeReference() {
  return 'VN-' + Math.random().toString(36).slice(2, 7).toUpperCase();
}

// Attempts to create the appointment. Relies on the DB's unique index on
// (appointment_date, start_time) as the source of truth for "is this slot
// actually free" — the client-side check above is just for a fast UI,
// this insert is what actually prevents a double-booking race.
export async function bookAppointment({ serviceId, date, time, name, phone, email }) {
  const reference = makeReference();

  const { data, error } = await supabase
    .from('appointments')
    .insert({
      service_id: serviceId,
      appointment_date: date,
      start_time: time,
      client_name: name,
      client_phone: phone,
      client_email: email || null,
      reference,
    })
    .select()
    .single();

  if (error) {
    // Postgres unique_violation → someone else just took this slot
    if (error.code === '23505') {
      throw new Error('SLOT_TAKEN');
    }
    throw error;
  }

  // Fire-and-forget: trigger the confirmation email/SMS edge function.
  // (See send-confirmation.js — you can also wire this as a Supabase
  // Database Webhook on INSERT into `appointments` instead of calling it
  // here, which is more reliable since it doesn't depend on the client
  // staying online.)
  supabase.functions.invoke('send-confirmation', { body: { appointmentId: data.id } })
    .catch(() => {}); // don't block the UI on this

  return data;
}
