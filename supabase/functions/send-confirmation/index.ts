// supabase/functions/send-confirmation/index.ts
//
// Deploy with: supabase functions deploy send-confirmation
// Call it either:
//   (a) directly from the client after booking (see booking-client.js), or
//   (b) — recommended — as a Database Webhook: Supabase Dashboard →
//       Database → Webhooks → on INSERT to `appointments` → call this
//       function. That way confirmations still send even if the client's
//       phone loses signal right after booking.
//
// Secrets needed (set with `supabase secrets set KEY=value`):
//   RESEND_API_KEY   – resend.com, free tier covers small volume
//   TWILIO_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_FROM_NUMBER
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (auto-injected by Supabase)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL'),
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') // service role: bypasses RLS to read the full row
);

Deno.serve(async (req) => {
  try {
    const body = await req.json();
    // Webhook payload shape: { record: {...} }. Direct-call shape: { appointmentId }.
    const appointmentId = body.record?.id ?? body.appointmentId;

    const { data: appt, error } = await supabase
      .from('appointments')
      .select('*, services(name, duration_minutes, price_cents)')
      .eq('id', appointmentId)
      .single();
    if (error || !appt) throw new Error('Appointment not found');

    const dateLabel = new Date(appt.appointment_date + 'T00:00:00')
      .toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    const priceLabel = (appt.services.price_cents / 100).toFixed(0) + '€';

    const results = { email: null, sms: null };

    // ---- Email via Resend ----
    if (appt.client_email) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${Deno.env.get('RESEND_API_KEY')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'Vernis <rendezvous@votredomaine.fr>',
          to: appt.client_email,
          subject: `Rendez-vous confirmé — ${dateLabel} à ${appt.start_time.slice(0,5)}`,
          html: `
            <p>Bonjour ${appt.client_name},</p>
            <p>Votre rendez-vous est confirmé :</p>
            <ul>
              <li><strong>Prestation :</strong> ${appt.services.name}</li>
              <li><strong>Date :</strong> ${dateLabel}</li>
              <li><strong>Heure :</strong> ${appt.start_time.slice(0,5)}</li>
              <li><strong>Durée :</strong> ${appt.services.duration_minutes} min</li>
              <li><strong>Prix :</strong> ${priceLabel}</li>
            </ul>
            <p>Référence : ${appt.reference}</p>
            <p>À bientôt !</p>
          `,
        }),
      });
      results.email = res.ok ? 'sent' : `failed (${res.status})`;
    }

    // ---- SMS via Twilio ----
    if (appt.client_phone) {
      const sid = Deno.env.get('TWILIO_SID');
      const token = Deno.env.get('TWILIO_AUTH_TOKEN');
      const from = Deno.env.get('TWILIO_FROM_NUMBER');
      const auth = btoa(`${sid}:${token}`);

      const smsBody =
        `Vernis: RDV confirmé le ${dateLabel} à ${appt.start_time.slice(0,5)} ` +
        `(${appt.services.name}). Réf ${appt.reference}.`;

      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          To: appt.client_phone,
          From: from,
          Body: smsBody,
        }),
      });
      results.sms = res.ok ? 'sent' : `failed (${res.status})`;
    }

    return new Response(JSON.stringify({ ok: true, results }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});

// Reminder SMS (e.g. sent 24h before): schedule a second Supabase Edge
// Function on a cron trigger (pg_cron or Supabase Scheduled Functions)
// that queries appointments where appointment_date = tomorrow and status
// = 'confirmed', then reuses the Twilio block above.
