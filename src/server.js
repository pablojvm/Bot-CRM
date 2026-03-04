/**
 * server.js (Bell Moon Aesthetics) — listo para cuando Meta/WhatsApp esté aprobado
 *
 * ✅ Sin SMTP (Railway suele bloquear SMTP)
 * ✅ WhatsApp:
 *   - Texto normal (si no hay template aprobado)
 *   - Template (si defines TEMPLATE_NAME / TEMPLATE_LANG)
 * ✅ Google Calendar:
 *   - Crea evento
 *   - Envía invitación por email via Google (attendees + sendUpdates:"all")
 * ✅ CRM webhook:
 *   - /crm/new-lead -> envía WhatsApp (template o texto) con link de Fresha
 * ✅ Meta Lead Ads:
 *   - /webhook/meta-leads guarda en leads_inbox
 *   - /cron/process-leads procesa inbox (dedupe + upsert mínimo)
 * ✅ WhatsApp inbound:
 *   - /webhook recibe mensajes
 *   - agenda (propone huecos, reserva, pide email, envía invite Google)
 * ✅ Crons:
 *   - /cron/followups
 *   - /cron/reminders
 *
 * -------------------
 * ENV REQUERIDAS
 * -------------------
 * OPENAI_API_KEY
 * PHONE_NUMBER_ID
 * WHATSAPP_TOKEN
 * VERIFY_TOKEN
 *
 * CRON_TOKEN
 *
 * GOOGLE_CLIENT_ID
 * GOOGLE_CLIENT_SECRET
 * GOOGLE_REDIRECT_URL
 *
 * META_LEADS_VERIFY_TOKEN
 *
 * FRESHA_BOOKING_LINK
 *
 * (Opcional pero recomendado)
 * CRM_WEBHOOK_TOKEN
 * TEMPLATE_NAME            // nombre del template aprobado (p.ej. "bellmoon_welcome")
 * TEMPLATE_LANG            // p.ej. "en_GB" o "es_ES"
 * TEMPLATE_PARAM_MODE      // "name_first" | "name_and_link" | "link_only" (default: name_and_link)
 */

require("dotenv").config();

const dns = require("dns");
if (dns.setDefaultResultOrder) dns.setDefaultResultOrder("ipv4first");

const express = require("express");
const OpenAI = require("openai");
const { google } = require("googleapis");
const pool = require("../db");

const app = express();
app.use(express.json({ type: "*/*" }));

/* ========================================================================== */
/*                                   Utils                                    */
/* ========================================================================== */

function extractEmail(text = "") {
  const m = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0] : null;
}

function normalizePhone(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const cleaned = s.replace(/[^\d+]/g, "");
  if (!cleaned) return null;
  return cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
}

// dedupe simple en memoria para CRM (evitar dobles envíos por reintentos)
const RECENT = new Map();
const DEDUPE_TTL_MS = 10 * 60 * 1000;
function isDuplicate(key) {
  const now = Date.now();
  for (const [k, ts] of RECENT) if (now - ts > DEDUPE_TTL_MS) RECENT.delete(k);
  if (RECENT.has(key)) return true;
  RECENT.set(key, now);
  return false;
}

function wantsAppointment(text = "") {
  const t = text.toLowerCase();
  return /(cita|reserv|agenda|agendar|turno|hueco|disponibil|book|booking|appointment|consult|consultation|slot|availability|mañana|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo|\b\d{1,2}:\d{2}\b)/.test(
    t
  );
}

function parseChoice(text = "") {
  const m = text.trim().match(/^([1-3])\b/);
  return m ? Number(m[1]) : null;
}

/* ========================================================================== */
/*                                   OpenAI                                   */
/* ========================================================================== */

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function generateReply(userMessage) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
You are Bell Moon Aesthetics London's official assistant on WhatsApp.

STYLE
- Professional, warm, elegant.
- Keep responses short (1–4 sentences).
- Reply in the user's language: British English or Spanish (Spain).
- Ask only ONE question per message.

SAFETY (medical)
- Do NOT provide medical advice, diagnosis, or prescriptions.
- You CAN answer general/non-medical questions (prices only if provided; otherwise offer consultation).
- If asked anything medical: encourage a consultation and offer a booking link or suggest speaking to a clinician.

GOAL
1) Identify treatment interest / intent.
2) Give brief non-medical info.
3) Drive to book a consultation.
`.trim(),
      },
      { role: "user", content: userMessage },
    ],
  });

  return response.choices?.[0]?.message?.content || "How can I help you today?";
}

/* ========================================================================== */
/*                               WhatsApp (Meta)                              */
/* ========================================================================== */

async function sendWhatsAppText(to, message) {
  if (!to) return null;

  const url = `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: to.replace("+", ""),
      type: "text",
      text: { body: message },
    }),
  });

  const data = await response.json();

  if (!response.ok) console.error("WHATSAPP SEND ERROR ❌", data);
  else console.log("WHATSAPP SENT ✅", data);

  return data;
}

async function sendWhatsAppTemplate(to, templateName, lang = "en_GB", params = []) {
  if (!to) return null;

  const url = `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`;

  const body = {
    messaging_product: "whatsapp",
    to: to.replace("+", ""),
    type: "template",
    template: {
      name: templateName,
      language: { code: lang },
    },
  };

  if (params.length) {
    body.template.components = [
      {
        type: "body",
        parameters: params.map((p) => ({ type: "text", text: String(p) })),
      },
    ];
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  if (!response.ok) console.error("WHATSAPP TEMPLATE ERROR ❌", data);
  else console.log("WHATSAPP TEMPLATE SENT ✅", data);

  return data;
}

async function sendWelcomeMessage({ waTo, name, link }) {
  const template = process.env.TEMPLATE_NAME;
  const lang = process.env.TEMPLATE_LANG || "en_GB";
  const mode = (process.env.TEMPLATE_PARAM_MODE || "name_and_link").toLowerCase();

  // Si hay template, úsalo (lo correcto para iniciar conversación con leads nuevos)
  if (template) {
    let params = [];
    if (mode === "name_first") params = [name || "there"];
    else if (mode === "link_only") params = [link];
    else params = [name || "there", link];

    try {
      return await sendWhatsAppTemplate(waTo, template, lang, params);
    } catch (e) {
      console.error("TEMPLATE FALLBACK ERROR ❌", e);
      // fallback a texto
    }
  }

  // Fallback texto normal (para cuando aún no está aprobado el template)
  const msg =
    `Hi${name ? ` ${name}` : ""}! Thanks for reaching out to Bell Moon Aesthetics London. ` +
    `You can book your consultation here: ${link}`;

  return await sendWhatsAppText(waTo, msg);
}

/* ========================================================================== */
/*                           Google Calendar + OAuth                          */
/* ========================================================================== */

function getGoogleOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URL
  );
}

async function getGoogleCalendarClient(clientId = "default") {
  const { rows } = await pool.query(
    "select refresh_token from integrations_google where client_id = $1",
    [clientId]
  );

  if (!rows.length) throw new Error("No Google refresh_token for client");

  const oauth2Client = getGoogleOAuthClient();
  oauth2Client.setCredentials({ refresh_token: rows[0].refresh_token });

  return google.calendar({ version: "v3", auth: oauth2Client });
}

async function getBusyRanges({ clientId, timeMinISO, timeMaxISO }) {
  const calendar = await getGoogleCalendarClient(clientId);

  const fb = await calendar.freebusy.query({
    requestBody: {
      timeMin: timeMinISO,
      timeMax: timeMaxISO,
      items: [{ id: "primary" }],
    },
  });

  return fb.data.calendars?.primary?.busy || [];
}

async function createCalendarEvent({ clientId, summary, description, startISO, endISO }) {
  const calendar = await getGoogleCalendarClient(clientId);

  const ev = await calendar.events.insert({
    calendarId: "primary",
    requestBody: {
      summary,
      description,
      start: { dateTime: startISO, timeZone: "Europe/Madrid" },
      end: { dateTime: endISO, timeZone: "Europe/Madrid" },
    },
  });

  return ev.data;
}

/**
 * Envía invitación sin SMTP:
 * - añade attendee
 * - Google manda email (sendUpdates: "all")
 */
async function addAttendeeAndSendInvite({ clientId, eventId, attendeeEmail }) {
  const calendar = await getGoogleCalendarClient(clientId);

  const { data: event } = await calendar.events.get({
    calendarId: "primary",
    eventId,
  });

  const attendees = Array.isArray(event.attendees) ? event.attendees : [];
  const exists = attendees.some(
    (a) => (a.email || "").toLowerCase() === attendeeEmail.toLowerCase()
  );
  if (!exists) attendees.push({ email: attendeeEmail });

  await calendar.events.patch({
    calendarId: "primary",
    eventId,
    sendUpdates: "all",
    requestBody: { attendees },
  });

  return true;
}

/* -------------------------------- OAuth routes ----------------------------- */

app.get("/google/oauth/start", (req, res) => {
  const oauth2Client = getGoogleOAuthClient();

  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/calendar"],
  });

  res.redirect(url);
});

app.get("/google/oauth/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send("Missing code");

    const oauth2Client = getGoogleOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      return res
        .status(400)
        .send("No refresh_token received. Try again: /google/oauth/start");
    }

    await pool.query(
      `
      insert into integrations_google (client_id, refresh_token, updated_at)
      values ($1, $2, now())
      on conflict (client_id)
      do update set refresh_token = excluded.refresh_token, updated_at = now()
      `,
      ["default", tokens.refresh_token]
    );

    res.send("Google Calendar conectado ✅");
  } catch (e) {
    console.error(e);
    res.status(500).send("OAuth error");
  }
});

/* ========================================================================== */
/*                              Scheduling helpers                             */
/* ========================================================================== */

function ceilToNextMinutes(d, minutes = 30) {
  const ms = minutes * 60 * 1000;
  return new Date(Math.ceil(d.getTime() / ms) * ms);
}

function overlapsBusy(start, end, busyRanges) {
  const s = start.getTime();
  const e = end.getTime();
  return busyRanges.some((b) => {
    const bs = new Date(b.start).getTime();
    const be = new Date(b.end).getTime();
    return s < be && e > bs;
  });
}

function generateSlots1h({ now = new Date(), days = 7, count = 3, busyRanges = [] }) {
  const slots = [];
  const startFrom = ceilToNextMinutes(now, 30);

  for (let dayOffset = 0; dayOffset < days && slots.length < count; dayOffset++) {
    const day = new Date(startFrom);
    day.setDate(day.getDate() + dayOffset);

    const dow = day.getDay();
    if (dow === 0 || dow === 6) continue;

    const dayStart = new Date(day);
    dayStart.setHours(10, 0, 0, 0);

    const dayEnd = new Date(day);
    dayEnd.setHours(19, 0, 0, 0);

    let cursor = new Date(Math.max(dayStart.getTime(), startFrom.getTime()));

    while (cursor.getTime() + 60 * 60 * 1000 <= dayEnd.getTime() && slots.length < count) {
      const end = new Date(cursor.getTime() + 60 * 60 * 1000);
      if (!overlapsBusy(cursor, end, busyRanges)) {
        slots.push({ startISO: cursor.toISOString(), endISO: end.toISOString() });
      }
      cursor = new Date(cursor.getTime() + 30 * 60 * 1000);
    }
  }

  return slots;
}

function formatSlotsES(slots) {
  const fmt = new Intl.DateTimeFormat("es-ES", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Madrid",
  });

  return slots
    .map((s, i) => {
      const d = new Date(s.startISO);
      return `${i + 1}) ${fmt.format(d).replace(",", "")}`;
    })
    .join("\n");
}

function formatSlotsEN(slots) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  });

  return slots
    .map((s, i) => {
      const d = new Date(s.startISO);
      return `${i + 1}) ${fmt.format(d).replace(",", "")}`;
    })
    .join("\n");
}

/* ========================================================================== */
/*                                 Basic routes                               */
/* ========================================================================== */

app.get("/health", (req, res) => res.status(200).send("ok"));

app.get("/db-test", async (req, res) => {
  try {
    const r = await pool.query("select now()");
    res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).send("db error");
  }
});

app.get("/ai-test", async (req, res) => {
  try {
    const reply = await generateReply("Hi, I want to book a consultation");
    res.send(reply);
  } catch (e) {
    console.error(e);
    res.status(500).send("AI error");
  }
});

/* ========================================================================== */
/*                         Meta Webhook (WhatsApp) GET                         */
/* ========================================================================== */

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    console.log("Webhook verificado");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/* ========================================================================== */
/*                      Meta Lead Ads Webhook (GET/POST)                       */
/* ========================================================================== */

app.get("/webhook/meta-leads", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.META_LEADS_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhook/meta-leads", async (req, res) => {
  try {
    const body = req.body;
    await pool.query(
      `insert into leads_inbox (client_id, source, raw_payload)
       values ($1, $2, $3::jsonb)`,
      ["default", "meta_leads", JSON.stringify(body)]
    );

    return res.sendStatus(200);
  } catch (e) {
    console.error("META LEADS WEBHOOK ERROR ❌", e);
    return res.sendStatus(200);
  }
});

// Extrae leadgen_id del payload típico de Meta Lead Ads
function extractLeadgenId(raw = {}) {
  try {
    const entry = raw?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    return value?.leadgen_id || null;
  } catch {
    return null;
  }
}

async function processLeadsInbox({ clientId = "default", limit = 20 }) {
  const { rows } = await pool.query(
    `
    select id, client_id, source, raw_payload
    from leads_inbox
    where client_id = $1
      and source = 'meta_leads'
      and status = 'pending'
    order by received_at asc
    limit $2
    `,
    [clientId, limit]
  );

  let processed = 0;

  for (const item of rows) {
    const lock = await pool.query(
      `
      update leads_inbox
      set status = 'processing'
      where id = $1 and status = 'pending'
      returning id
      `,
      [item.id]
    );
    if (lock.rowCount === 0) continue;

    try {
      const externalId = extractLeadgenId(item.raw_payload);
      if (!externalId) {
        await pool.query(
          `update leads_inbox set status='error', error=$2, processed_at=now() where id=$1`,
          [item.id, "No leadgen_id in payload"]
        );
        continue;
      }

      // Dedupe por (client_id, source, external_id)
      const dedupe = await pool.query(
        `
        insert into leads_inbox_dedupe (client_id, source, external_id)
        values ($1,$2,$3)
        on conflict do nothing
        `,
        [clientId, item.source, externalId]
      );

      if (dedupe.rowCount === 0) {
        await pool.query(`update leads_inbox set status='duplicate', processed_at=now() where id=$1`, [
          item.id,
        ]);
        continue;
      }

      // Upsert lead mínimo
      const up = await pool.query(
        `
        insert into leads (client_id, source, external_id, meta_payload, created_at)
        values ($1,$2,$3,$4::jsonb, now())
        on conflict (client_id, source, external_id)
        do update set meta_payload = excluded.meta_payload
        returning id
        `,
        [clientId, item.source, externalId, JSON.stringify(item.raw_payload)]
      );

      const leadId = up.rows?.[0]?.id;

      await pool.query(
        `
        update leads
        set stage = coalesce(stage,'new'),
            score = coalesce(score, 0),
            urgency = coalesce(urgency,'low')
        where id = $1
        `,
        [leadId]
      );

      await pool.query(`update leads_inbox set status='processed', processed_at=now() where id=$1`, [
        item.id,
      ]);

      processed++;
    } catch (e) {
      console.error("PROCESS INBOX ITEM ERROR ❌", e);
      await pool.query(
        `update leads_inbox set status='error', error=$2, processed_at=now() where id=$1`,
        [item.id, String(e?.message || e)]
      );
    }
  }

  return { candidates: rows.length, processed };
}

app.get("/cron/process-leads", async (req, res) => {
  try {
    const token = req.query.token;
    if (!token || token !== process.env.CRON_TOKEN) return res.status(401).send("unauthorized");

    const result = await processLeadsInbox({ clientId: "default", limit: 20 });
    return res.json({ ok: true, ...result });
  } catch (e) {
    console.error("CRON PROCESS LEADS ERROR ❌", e);
    return res.status(500).json({ ok: false });
  }
});

/* ========================================================================== */
/*                                Follow-ups cron                              */
/* ========================================================================== */

async function runFollowups() {
  const clientId = "default";

  const { rows } = await pool.query(
    `
    select lf.client_id, lf.lead_id, lf.step, lf.next_run_at, l.wa_from, l.name
    from lead_followups lf
    join leads l on l.id = lf.lead_id
    where lf.client_id = $1
      and lf.is_active = true
      and lf.next_run_at <= now()
      and l.wa_from is not null
    order by lf.next_run_at asc
    limit 20
    `,
    [clientId]
  );

  let processed = 0;

  for (const f of rows) {
    const lock = await pool.query(
      `
      update lead_followups
      set updated_at = now()
      where client_id = $1
        and lead_id = $2
        and is_active = true
        and next_run_at <= now()
      returning client_id, lead_id, step
      `,
      [f.client_id, f.lead_id]
    );

    if (lock.rowCount === 0) continue;

    const msg =
      `Hi${f.name ? ` ${f.name}` : ""}! Just checking in — would you like help booking a consultation, ` +
      `or would you prefer more info first?`;

    await sendWhatsAppText(f.wa_from, msg);

    await pool.query(
      `
      insert into events (client_id, lead_id, type, payload)
      values ($1, $2, 'followup_sent', jsonb_build_object('step', $3::int, 'text', $4::text))
      `,
      [f.client_id, f.lead_id, f.step, msg]
    );

    await pool.query(
      `
      update lead_followups
      set step = step + 1,
          next_run_at = now() + interval '1 hour',
          updated_at = now()
      where client_id = $1 and lead_id = $2
      `,
      [f.client_id, f.lead_id]
    );

    processed++;
  }

  return { processed, candidates: rows.length };
}

app.get("/cron/followups", async (req, res) => {
  try {
    const token = req.query.token;
    if (!token || token !== process.env.CRON_TOKEN) return res.status(401).send("unauthorized");

    const result = await runFollowups();
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error("CRON FOLLOWUPS ERROR ❌", e);
    res.status(500).json({ ok: false });
  }
});

/* ========================================================================== */
/*                             Appointment reminders cron                      */
/* ========================================================================== */

async function runAppointmentReminders() {
  const clientId = "default";

  const { rows } = await pool.query(
    `
    select ar.client_id, ar.lead_id, ar.event_id, ar.kind, ar.start_at, l.wa_from, l.name
    from appointment_reminders ar
    join leads l on l.id = ar.lead_id
    where ar.client_id = $1
      and ar.is_sent = false
      and ar.remind_at <= now()
      and l.wa_from is not null
    order by ar.remind_at asc
    limit 30
    `,
    [clientId]
  );

  let processed = 0;

  for (const r of rows) {
    const lock = await pool.query(
      `
      update appointment_reminders
      set is_sent = true, sent_at = now()
      where client_id = $1 and event_id = $2 and kind = $3 and is_sent = false
      returning client_id
      `,
      [r.client_id, r.event_id, r.kind]
    );

    if (lock.rowCount === 0) continue;

    const startLocal = new Date(r.start_at).toLocaleString("en-GB", { timeZone: "Europe/London" });

    const msg =
      r.kind === "24h"
        ? `Hi${r.name ? ` ${r.name}` : ""}! Reminder: you have a consultation tomorrow.\nDate & time: ${startLocal}\n\nIf you need to reschedule, just reply here.`
        : `Hi${r.name ? ` ${r.name}` : ""}! Reminder: your consultation is in about 2 hours.\nDate & time: ${startLocal}\n\nIf you need to reschedule, just reply here.`;

    await sendWhatsAppText(r.wa_from, msg);

    await pool.query(
      `
      insert into events (client_id, lead_id, type, payload)
      values ($1, $2, 'appointment_reminder_sent', jsonb_build_object('kind',$3::text,'eventId',$4::text,'text',$5::text))
      `,
      [r.client_id, r.lead_id, r.kind, r.event_id, msg]
    );

    processed++;
  }

  return { processed, candidates: rows.length };
}

app.get("/cron/reminders", async (req, res) => {
  try {
    const token = req.query.token;
    if (!token || token !== process.env.CRON_TOKEN) return res.status(401).send("unauthorized");

    const result = await runAppointmentReminders();
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error("CRON REMINDERS ERROR ❌", e);
    res.status(500).json({ ok: false });
  }
});

/* ========================================================================== */
/*                           CRM Webhook -> WhatsApp                           */
/* ========================================================================== */

app.post("/crm/new-lead", async (req, res) => {
  try {
    // token simple opcional
    const token = req.headers["x-crm-token"];
    if (process.env.CRM_WEBHOOK_TOKEN && token !== process.env.CRM_WEBHOOK_TOKEN) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const body = req.body || {};
    const contact = body.contact || body;

    const phone =
      contact.phone ||
      contact.Phone ||
      contact.mobile ||
      contact.mobilePhone ||
      contact?.customFields?.phone ||
      contact?.customFields?.Phone;

    const name =
      contact.firstName ||
      contact.firstname ||
      contact.name ||
      contact.fullName ||
      contact.contactName ||
      null;

    const waTo = normalizePhone(phone);

    if (!waTo) return res.status(200).json({ ok: true, skipped: true, reason: "no phone" });

    const link = process.env.FRESHA_BOOKING_LINK;
    if (!link) return res.status(500).json({ ok: false, error: "Missing FRESHA_BOOKING_LINK" });

    // dedupe key: phone + day (simple)
    const dayKey = new Date().toISOString().slice(0, 10);
    const key = `crm:${waTo}:${dayKey}`;
    if (isDuplicate(key)) return res.status(200).json({ ok: true, deduped: true });

    await sendWelcomeMessage({ waTo, name, link });

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("CRM WEBHOOK ERROR ❌", e);
    return res.status(200).json({ ok: false });
  }
});

/* ========================================================================== */
/*                          WhatsApp Webhook (POST)                             */
/* ========================================================================== */

app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    if (body?.object !== "whatsapp_business_account") return res.sendStatus(200);

    const change = body.entry?.[0]?.changes?.[0]?.value;
    const msg = change?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const clientId = "default";
    const messageId = msg.id;

    // Dedupe inbound
    if (messageId) {
      const dedupe = await pool.query(
        "insert into inbound_dedupe (client_id, message_id) values ($1,$2) on conflict do nothing",
        [clientId, messageId]
      );
      if (dedupe.rowCount === 0) return res.sendStatus(200);
    }

    const phone = msg.from;
    const text = msg.text?.body || "";
    const name = change?.contacts?.[0]?.profile?.name || null;
    const waFrom = phone ? `+${phone}` : null;

    // Guardar inbound + lead (tu función SQL)
    const r = await pool.query("select * from upsert_inbound_whatsapp($1,$2,$3,$4)", [
      clientId,
      waFrom,
      name,
      text,
    ]);
    const outLeadId = r.rows?.[0]?.out_lead_id;
    if (!outLeadId) return res.sendStatus(200);

    /* ------------------------ Invitación: esperando email ------------------------ */
    {
      const { rows: st } = await pool.query(
        "select awaiting_email, last_event from scheduling_state where client_id=$1 and lead_id=$2",
        [clientId, outLeadId]
      );

      const awaiting = st[0]?.awaiting_email === true;
      const email = extractEmail(text);

      if (awaiting && email) {
        const lastEvent = st[0]?.last_event || {};
        const eventId = lastEvent.eventId;

        if (!eventId) {
          await sendWhatsAppText(
            waFrom,
            "Thanks — I can’t find the appointment linked. Please type “book” and I’ll share available slots."
          );
          return res.sendStatus(200);
        }

        await pool.query("update leads set email=$1 where id=$2", [email, outLeadId]);

        try {
          await addAttendeeAndSendInvite({ clientId, eventId, attendeeEmail: email });
          await sendWhatsAppText(waFrom, `Perfect ✅ Invitation sent to ${email}.`);
        } catch (e) {
          console.error("CAL INVITE ERROR ❌", e);
          await sendWhatsAppText(
            waFrom,
            "I tried to send the invitation but it failed. Could you confirm the email address?"
          );
          return res.sendStatus(200);
        }

        await pool.query(
          "update scheduling_state set awaiting_email=false, updated_at=now() where client_id=$1 and lead_id=$2",
          [clientId, outLeadId]
        );

        await pool.query(
          `
          insert into events (client_id, lead_id, type, payload)
          values ($1,$2,'appointment_invite_sent', jsonb_build_object('email',$3::text,'eventId',$4::text))
          `,
          [clientId, outLeadId, email, eventId]
        );

        return res.sendStatus(200);
      }
    }

    /* ----------------------------------- AGENDA ---------------------------------- */
    if (wantsAppointment(text)) {
      const choice = parseChoice(text);

      // Si elige 1/2/3 => reservar
      if (choice) {
        const { rows: stRows } = await pool.query(
          "select proposed from scheduling_state where client_id=$1 and lead_id=$2",
          [clientId, outLeadId]
        );

        const proposed = stRows[0]?.proposed || [];
        const picked = proposed[choice - 1];

        if (!picked) {
          await sendWhatsAppText(waFrom, "I can’t find that slot. Type “book” and I’ll share new options.");
          return res.sendStatus(200);
        }

        const ev = await createCalendarEvent({
          clientId,
          summary: `Bell Moon Consultation - ${name || waFrom}`,
          description: `Lead ${outLeadId} | WhatsApp ${waFrom}`,
          startISO: picked.startISO,
          endISO: picked.endISO,
        });

        // recordatorios (24h y 2h)
        const startAt = new Date(picked.startISO);
        const remind24h = new Date(startAt.getTime() - 24 * 60 * 60 * 1000);
        const remind2h = new Date(startAt.getTime() - 2 * 60 * 60 * 1000);

        await pool.query(
          `
          insert into appointment_reminders (client_id, lead_id, event_id, start_at, remind_at, kind)
          values
            ($1,$2,$3,$4,$5,'24h'),
            ($1,$2,$3,$4,$6,'2h')
          on conflict do nothing
          `,
          [clientId, outLeadId, ev.id, startAt.toISOString(), remind24h.toISOString(), remind2h.toISOString()]
        );

        // estado: pedir email para enviar invitación
        await pool.query(
          `
          insert into scheduling_state (client_id, lead_id, awaiting_email, last_event, updated_at)
          values ($1,$2,true, jsonb_build_object('eventId',$3::text,'startISO',$4::text,'endISO',$5::text), now())
          on conflict (client_id, lead_id)
          do update set awaiting_email=true, last_event=excluded.last_event, updated_at=now()
          `,
          [clientId, outLeadId, ev.id, picked.startISO, picked.endISO]
        );

        // si ya hay email guardado => invitar sin preguntar
        const { rows: leadRows } = await pool.query("select email from leads where id=$1", [outLeadId]);
        const savedEmail = leadRows?.[0]?.email || null;

        if (savedEmail) {
          try {
            await addAttendeeAndSendInvite({ clientId, eventId: ev.id, attendeeEmail: savedEmail });

            await pool.query(
              "update scheduling_state set awaiting_email=false, updated_at=now() where client_id=$1 and lead_id=$2",
              [clientId, outLeadId]
            );

            await sendWhatsAppText(
              waFrom,
              `Booked ✅\nStart: ${new Date(picked.startISO).toLocaleString("en-GB", {
                timeZone: "Europe/London",
              })}\nDuration: 1 hour\n\nInvitation sent to ${savedEmail}.`
            );
            return res.sendStatus(200);
          } catch (e) {
            console.error("CAL INVITE ERROR ❌", e);
          }
        }

        await sendWhatsAppText(
          waFrom,
          `Booked ✅\nStart: ${new Date(picked.startISO).toLocaleString("en-GB", {
            timeZone: "Europe/London",
          })}\nDuration: 1 hour\n\nWhat email should I send the calendar invitation to?`
        );
        return res.sendStatus(200);
      }

      // Proponer huecos
      const now = new Date();
      const timeMinISO = now.toISOString();
      const timeMax = new Date(now);
      timeMax.setDate(timeMax.getDate() + 7);
      const timeMaxISO = timeMax.toISOString();

      const busy = await getBusyRanges({ clientId, timeMinISO, timeMaxISO });
      const slots = generateSlots1h({ now, days: 7, count: 3, busyRanges: busy });

      if (!slots.length) {
        await sendWhatsAppText(waFrom, "I can’t see availability this week. Would next week work for you?");
        return res.sendStatus(200);
      }

      await pool.query(
        `insert into scheduling_state (client_id, lead_id, proposed, updated_at)
         values ($1,$2,$3::jsonb, now())
         on conflict (client_id, lead_id)
         do update set proposed = excluded.proposed, updated_at = now()`,
        [clientId, outLeadId, JSON.stringify(slots)]
      );

      const msgText =
        "Here are the next available 1-hour slots:\n" +
        formatSlotsEN(slots) +
        "\n\nReply with 1, 2, or 3 to book.";

      await sendWhatsAppText(waFrom, msgText);
      return res.sendStatus(200);
    }

    /* ---------------------------------- IA normal ------------------------------- */
    let aiReply;
    try {
      aiReply = await generateReply(text);
    } catch (err) {
      console.error("AI ERROR ❌", err);
      aiReply = "Sorry — I can’t reply right now. Please try again in a few minutes.";
    }

    await pool.query(
      `insert into events (client_id, lead_id, type, payload)
       values ($1, $2, 'outbound_msg', jsonb_build_object('text', $3::text))`,
      [clientId, outLeadId, aiReply]
    );

    await sendWhatsAppText(waFrom, aiReply);
    return res.sendStatus(200);
  } catch (e) {
    console.error("WEBHOOK ERROR ❌", e);
    return res.sendStatus(200);
  }
});

/* ========================================================================== */
/*                                   Server                                   */
/* ========================================================================== */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("listening on", PORT));