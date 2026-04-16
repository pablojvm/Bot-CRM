/**
 * server.js (Bell Moon Aesthetics)
 *
 * ✅ WhatsApp: texto libre (sin template)
 * ✅ Google Calendar: agenda citas + invitación por email vía Google
 * ✅ CRM webhook (GoHighLevel): /crm/new-lead → envía WhatsApp con link de Fresha
 * ✅ WhatsApp inbound: agenda (propone huecos, reserva, pide email, envía invite)
 * ✅ Crons: /cron/followups y /cron/reminders
 *
 * -------------------
 * ENV REQUERIDAS
 * -------------------
 * OPENAI_API_KEY
 * PHONE_NUMBER_ID
 * WHATSAPP_TOKEN
 * VERIFY_TOKEN
 * CRON_TOKEN
 * GOOGLE_CLIENT_ID
 * GOOGLE_CLIENT_SECRET
 * GOOGLE_REDIRECT_URL
 * FRESHA_BOOKING_LINK
 *
 * (Opcional)
 * CRM_WEBHOOK_TOKEN
 */

require("dotenv").config();

const dns = require("dns");
if (dns.setDefaultResultOrder) dns.setDefaultResultOrder("ipv4first");

const crypto = require("crypto");
const express = require("express");
const OpenAI = require("openai");
const { google } = require("googleapis");
const pool = require("../db");

const app = express();

/* ========================================================================== */
/*                       Webhook Signature Verification                       */
/* ========================================================================== */

/**
 * Verifica la firma X-Hub-Signature-256 de Meta en cada POST al webhook.
 * Si APP_SECRET no está configurado, se loguea un warning pero se deja pasar
 * (para desarrollo). En producción APP_SECRET DEBE estar configurado.
 */
function verifySignature(req, res, buf) {
  if (!process.env.APP_SECRET) {
    console.warn("⚠️  APP_SECRET not set — skipping webhook signature verification (unsafe for production)");
    return;
  }

  const signature = req.headers["x-hub-signature-256"];
  if (!signature) {
    throw new Error("Missing X-Hub-Signature-256 header");
  }

  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", process.env.APP_SECRET)
      .update(buf)
      .digest("hex");

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw new Error("Invalid webhook signature");
  }
}

app.use(express.json({ verify: verifySignature }));

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

// Dedupe simple en memoria para CRM (evitar dobles envíos por reintentos)
const RECENT = new Map();
const DEDUPE_TTL_MS = 10 * 60 * 1000;
function isDuplicate(key) {
  const now = Date.now();
  for (const [k, ts] of RECENT) if (now - ts > DEDUPE_TTL_MS) RECENT.delete(k);
  if (RECENT.has(key)) return true;
  RECENT.set(key, now);
  return false;
}

/* ========================================================================== */
/*                         Before/After Photos (Cloudinary)                   */
/* ========================================================================== */

const TREATMENT_PHOTOS = {
  lips: [
    { url: "https://res.cloudinary.com/dvqe1t4uh/image/upload/v1774515135/Lips_2_reyaf5.jpg", caption: "✨ Before & After — Bell Moon Aesthetics London" },
    { url: "https://res.cloudinary.com/dvqe1t4uh/image/upload/v1774515127/Lips_1_fhan5n.jpg", caption: "✨ Before & After — Bell Moon Aesthetics London" },
    { url: "https://res.cloudinary.com/dvqe1t4uh/image/upload/v1774515143/%D7%A9%D7%A4%D7%AA%D7%99%D7%99%D7%9D_%D7%97%D7%93%D7%A9_bkgs6r.jpg", caption: "✨ Results — Bell Moon Aesthetics London" },
    { url: "https://res.cloudinary.com/dvqe1t4uh/image/upload/v1774515126/Lips_urybbk.jpg", caption: "✨ Results — Bell Moon Aesthetics London" },
    { url: "https://res.cloudinary.com/dvqe1t4uh/image/upload/v1774515140/%D7%9E%D7%99%D7%9C%D7%95%D7%99_%D7%A9%D7%A4%D7%AA%D7%99%D7%99%D7%9D_%D7%90%D7%97%D7%A8%D7%99_jyxccc.heic", caption: "✨ Results — Bell Moon Aesthetics London" },
  ],
  nose: [
    { url: "https://res.cloudinary.com/dvqe1t4uh/image/upload/v1774515125/%D7%9E%D7%99%D7%9C%D7%95%D7%99_%D7%90%D7%A3_nose_zmq12q.jpg", caption: "✨ Before & After — Bell Moon Aesthetics London" },
    { url: "https://res.cloudinary.com/dvqe1t4uh/image/upload/v1774515125/Nose_wjbkr8.jpg", caption: "✨ Before & After — Bell Moon Aesthetics London" },
    { url: "https://res.cloudinary.com/dvqe1t4uh/video/upload/v1774515124/Nose_fillers_go0n28.mov", caption: "✨ Results — Bell Moon Aesthetics London" },
  ],
  double_chin: [
    { url: "https://res.cloudinary.com/dvqe1t4uh/image/upload/v1774515119/IMG_1057_ea0m4i.jpg", caption: "✨ Before & After — Bell Moon Aesthetics London" },
    { url: "https://res.cloudinary.com/dvqe1t4uh/image/upload/v1774515119/IMG_6326_ngm3nm.jpg", caption: "✨ Before & After — Bell Moon Aesthetics London" },
    { url: "https://res.cloudinary.com/dvqe1t4uh/image/upload/v1774515120/Double_chin_1_vvnvy9.jpg", caption: "✨ Before & After — Bell Moon Aesthetics London" },
  ],
  dark_circles: [
    { url: "https://res.cloudinary.com/dvqe1t4uh/image/upload/v1774515124/Eyes_cl3xrd.jpg", caption: "✨ Before & After — Bell Moon Aesthetics London" },
    { url: "https://res.cloudinary.com/dvqe1t4uh/image/upload/v1774515118/IMG_1876_f9nmdf.jpg", caption: "✨ Before & After — Bell Moon Aesthetics London" },
  ],
  pigmentation: [
    { url: "https://res.cloudinary.com/dvqe1t4uh/image/upload/v1774515123/Pigmentation_2_ftn2dy.jpg", caption: "✨ Before & After — Bell Moon Aesthetics London" },
    { url: "https://res.cloudinary.com/dvqe1t4uh/video/upload/v1774515115/Pigmentation_sbb4du.mov", caption: "✨ Results — Bell Moon Aesthetics London" },
  ],
  microneedling: [
    { url: "https://res.cloudinary.com/dvqe1t4uh/video/upload/v1774515231/Micronidling_z1let5.mov", caption: "✨ Results — Bell Moon Aesthetics London" },
  ],
  veins: [
    { url: "https://res.cloudinary.com/dvqe1t4uh/image/upload/v1774515121/Veins_removal_ultpub.jpg", caption: "✨ Before & After — Bell Moon Aesthetics London" },
    { url: "https://res.cloudinary.com/dvqe1t4uh/image/upload/v1774515144/%D7%95%D7%A8%D7%99%D7%93%D7%99%D7%9D_%D7%A0%D7%99%D7%9E%D7%99%D7%9D_%D7%97%D7%93%D7%A9_zfkiii.jpg", caption: "✨ Before & After — Bell Moon Aesthetics London" },
  ],
  abdomen: [
    { url: "https://res.cloudinary.com/dvqe1t4uh/image/upload/v1774515242/%D7%91%D7%98%D7%9F_aczvph.jpg", caption: "✨ Before & After — Bell Moon Aesthetics London" },
    { url: "https://res.cloudinary.com/dvqe1t4uh/image/upload/v1774515243/%D7%91%D7%98%D7%9F__tkbtu3.jpg", caption: "✨ Before & After — Bell Moon Aesthetics London" },
    { url: "https://res.cloudinary.com/dvqe1t4uh/video/upload/v1774515244/%D7%91%D7%98%D7%9F_%D7%AA%D7%94%D7%9C%D7%99%D7%9A_%D7%98%D7%99%D7%A4%D7%95%D7%9C_ghqhef.mov", caption: "✨ Results — Bell Moon Aesthetics London" },
  ],
};

function detectTreatmentFromText(text = "") {
  const t = text.toLowerCase();
  if (/(lip|labio|boca|filler)/.test(t)) return "lips";
  if (/(nose|nariz|rhinoplast|nose filler)/.test(t)) return "nose";
  if (/(chin|papada|jawline|double chin)/.test(t)) return "double_chin";
  if (/(dark circle|ojera|under.?eye|eye bag)/.test(t)) return "dark_circles";
  if (/(microneedl|microaguja|collagen induction)/.test(t)) return "microneedling";
  if (/(pigment|manchas|melasma|dark spot|spot)/.test(t)) return "pigmentation";
  if (/(vein|vena|capillar|thread vein|spider)/.test(t)) return "veins";
  if (/(abdomen|belly|stomach|barriga|tripa|body contour|contorno)/.test(t)) return "abdomen";
  return null;
}

async function sendWhatsAppMedia(to, mediaUrl, caption = "") {
  if (!to || !mediaUrl) return null;
  const isVideo = /\.(mov|mp4|avi)$/i.test(mediaUrl);
  const url = `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`;
  const body = isVideo
    ? { messaging_product: "whatsapp", to: to.replace("+", ""), type: "video", video: { link: mediaUrl, caption } }
    : { messaging_product: "whatsapp", to: to.replace("+", ""), type: "image", image: { link: mediaUrl, caption } };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) console.error("WHATSAPP MEDIA ERROR ❌", data);
  else console.log("WHATSAPP MEDIA SENT ✅", isVideo ? "video" : "image");
  return data;
}

function wantsAppointment(text = "") {
  const t = text.toLowerCase();
  return /(cita|reserv|agenda|agendar|turno|hueco|disponibil|book|booking|appointment|consult|consultation|slot|availability|mañana|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo|\b\d{1,2}:\d{2}\b)/.test(t);
}

function parseChoice(text = "") {
  const m = text.trim().match(/^([1-3])\b/);
  return m ? Number(m[1]) : null;
}

/* ========================================================================== */
/*                                   OpenAI                                   */
/* ========================================================================== */

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Carga las últimas interacciones del lead para dar contexto a OpenAI.
 * Devuelve un array de { role, content } listo para el chat.
 */
async function loadConversationHistory(clientId, leadId, limit = 10) {
  const { rows } = await pool.query(
    `
    select type, payload, created_at
    from events
    where client_id = $1 and lead_id = $2
      and type in ('inbound_msg', 'outbound_msg')
    order by created_at desc
    limit $3
    `,
    [clientId, leadId, limit]
  );

  // rows vienen DESC, los invertimos para orden cronológico
  return rows.reverse().map((r) => ({
    role: r.type === "inbound_msg" ? "user" : "assistant",
    content: r.payload?.text || "",
  }));
}

async function generateReply(userMessage, { clientId = "default", leadId = null } = {}) {
  // Cargar historial si tenemos leadId
  let history = [];
  if (leadId) {
    try {
      history = await loadConversationHistory(clientId, leadId);
    } catch (e) {
      console.error("HISTORY LOAD ERROR ⚠️", e.message);
    }
  }

  // Añadir el mensaje actual al final
  history.push({ role: "user", content: userMessage });

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
You are the official WhatsApp assistant for Bell Moon Aesthetics, a premium aesthetic clinic in Mayfair, London (15 Hanover Square).
Founded by Mouna Noufi, the clinic combines advanced technology with an artistic eye for natural, subtle results.

════════════════════════════════
PERSONALITY & STYLE
════════════════════════════════
- Warm, elegant, professional. Never robotic.
- Keep replies SHORT (2–4 sentences max). One question at a time.
- Reply in the client's language: British English or Spanish (Spain).
- Use tasteful emojis occasionally (✨🌙) — never overdo it.
- Never use bullet points or lists — write in natural conversation.

════════════════════════════════
CONVERSATION GOAL
════════════════════════════════
1. Welcome the lead warmly.
2. Find out what treatment or concern they are interested in.
3. Warm them up: ask about the area of the body, whether they've had any treatments before.
4. Emphasise that every skin type is different — a consultation is the best next step.
5. Drive them to BOOK a consultation (in-clinic or by phone).
6. Close the appointment.

════════════════════════════════
TREATMENTS OFFERED
════════════════════════════════
Face:
- Botox / Lines & Wrinkles — smooths forehead lines, crow's feet, frown lines. No surgery, no downtime.
- Lip Fillers — natural volume enhancement, tailored to facial proportions.
- Nose Fillers — non-surgical rhinoplasty, subtle reshaping without surgery.
- Dark Circle Treatment — reduces pigmentation and hollowness under eyes.
- Sculptra® — collagen-stimulating injectable for gradual, natural volume restoration.
- Polynucleotides (PN/PDRN) — next-generation bio-stimulator that repairs and rejuvenates skin at a cellular level.
- Skin Booster & Profhilo — deep hydration and skin quality improvement.
- Pigmentation — laser and advanced treatments for dark spots, melasma, uneven tone.
- Microneedling — stimulates collagen, reduces pores, improves texture and pigmentation.
- Laser Vein & Capillary Removal — precise treatment for thread veins and broken capillaries.

Body:
- Body Contour Signature — non-surgical body sculpting and contouring.
- Double Chin Fat Dissolving — defines the jawline without surgery.

════════════════════════════════
MICRONEEDLING — DETAILED KNOWLEDGE
════════════════════════════════
Also known as Collagen Induction Therapy. Medical-grade devices create micro-channels in the skin, activating the body's natural healing response and increasing collagen production by up to 300% over time.

What it treats: fine lines & wrinkles, acne scars, pigmentation, enlarged pores, dull/tired skin, loss of firmness, uneven texture.

Treatment experience:
- Duration: 45–60 minutes
- Comfort: mild tingling, numbing cream available
- Downtime: light redness for 24–48 hours only
- Results: visible glow within days, collagen continues improving for up to 3 months per session

Recommended course: 6–8 sessions, every 3–4 weeks.

Aftercare (share if asked):
- Avoid direct sun for 48h, apply SPF daily, keep skin hydrated, avoid makeup for 24h.

Who should AVOID it: active acne, skin infections, eczema, rosacea, or pregnancy.

FAQs you can answer confidently:
- "Is it safe?" → Yes, performed by trained professionals with medical-grade devices.
- "Does it hurt?" → Minimal discomfort. Numbing cream applied beforehand.
- "How many sessions?" → 6–8 sessions every 3–4 weeks for best results.
- "When will I see results?" → Glow within days, collagen keeps improving over weeks.
- "Is there downtime?" → Mild redness for 24–48 hours only.
- "Can it be combined?" → Yes, with RF, mesotherapy, and advanced serums.
- "Is it for all skin types?" → Yes, personalised after consultation.
- "How long do results last?" → Several months with proper skincare and maintenance.

════════════════════════════════
KEY PHRASES TO USE NATURALLY
════════════════════════════════
- "No surgery, no downtime — you can return to your routine immediately."
- "The best results are typically achieved over a course of 4–8 sessions."
- "A consultation at the clinic is £40, which is fully deducted from the cost of your treatment."
- "Every skin type is different, which is why a personalised consultation is so important."

════════════════════════════════
PRICING RULES — VERY IMPORTANT
════════════════════════════════
- NEVER give specific treatment prices.
- If asked about cost, say: "Costs start from £300 and vary depending on the area and type of treatment. For an accurate quote, it's best to speak with Mouna directly at your consultation."
- The consultation itself is £40, redeemable against treatment.
- If client insists repeatedly, repeat the above — never go further.

════════════════════════════════
MEDICAL & SAFETY RULES
════════════════════════════════
- NEVER give medical advice, diagnosis, or prescriptions.
- If asked a complex clinical question, say: "That's a great question — it's best answered by Mouna directly. I can arrange a consultation for you."
- If a question is beyond your scope, escalate gracefully: "I want to make sure you get the right answer — let me connect you with our team."

════════════════════════════════
BOOKING
════════════════════════════════
- Consultation booking link: https://www.fresha.com/book-now/bell-moon-aesthtika-b9fmyxzy/all-offer?share=true&pId=2782567
- Phone: 07988931827
- Address: 15 Hanover Square, Mayfair, London
- When offering to book, always give BOTH options: online link or phone call.

════════════════════════════════
WHAT NOT TO DO
════════════════════════════════
- Do not send prices beyond what is stated above.
- Do not make promises about specific results.
- Do not diagnose or recommend specific treatments without a consultation.
- Do not mention competitor clinics.
`.trim(),
      },
      ...history,
    ],
  });

  return response.choices?.[0]?.message?.content || "How can I help you today?";
}

/* ========================================================================== */
/*                               WhatsApp (Meta)                              */
/* ========================================================================== */

async function sendWhatsAppText(to, message) {
  if (!to) return null;

  const url = `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`;

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
      start: { dateTime: startISO, timeZone: "Europe/London" },
      end: { dateTime: endISO, timeZone: "Europe/London" },
    },
  });

  return ev.data;
}

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
      return res.status(400).send("No refresh_token received. Try again: /google/oauth/start");
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

function formatSlots(slots) {
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

/* ========================================================================== */
/*                         Meta Webhook (WhatsApp) GET                         */
/* ========================================================================== */

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    console.log("Webhook verificado ✅");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/* ========================================================================== */
/*                           CRM Webhook (GoHighLevel)                         */
/* ========================================================================== */

app.post("/crm/new-lead", async (req, res) => {
  try {
    const token = req.headers["x-crm-token"];
    if (process.env.CRM_WEBHOOK_TOKEN && token !== process.env.CRM_WEBHOOK_TOKEN) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const body = req.body || {};

    const phone =
      body.phone ||
      body.Phone ||
      body.mobile ||
      body.mobilePhone ||
      body.contact?.phone ||
      body.contact?.Phone ||
      body.customData?.phone;

    const contact = body;

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

    // Dedupe: mismo número, mismo día
    const dayKey = new Date().toISOString().slice(0, 10);
    const key = `crm:${waTo}:${dayKey}`;
    if (isDuplicate(key)) return res.status(200).json({ ok: true, deduped: true });

    const msg =
      `Hi${name ? ` ${name}` : ""}! Thanks for reaching out to Bell Moon Aesthetics London. ` +
      `You can book your consultation here: ${link}`;

    await sendWhatsAppText(waTo, msg);

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("CRM WEBHOOK ERROR ❌", e);
    return res.status(200).json({ ok: false });
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

    const r = await pool.query("select * from upsert_inbound_whatsapp($1,$2,$3,$4)", [
      clientId,
      waFrom,
      name,
      text,
    ]);
    const outLeadId = r.rows?.[0]?.out_lead_id;
    if (!outLeadId) return res.sendStatus(200);

    /* ------------------- Esperando email para invitación ------------------- */
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
          await sendWhatsAppText(waFrom, "Thanks — I can't find the appointment linked. Please type \"book\" and I'll share available slots.");
          return res.sendStatus(200);
        }

        await pool.query("update leads set email=$1 where id=$2", [email, outLeadId]);

        try {
          await addAttendeeAndSendInvite({ clientId, eventId, attendeeEmail: email });
          await sendWhatsAppText(waFrom, `Perfect ✅ Invitation sent to ${email}.`);
        } catch (e) {
          console.error("CAL INVITE ERROR ❌", e);
          await sendWhatsAppText(waFrom, "I tried to send the invitation but it failed. Could you confirm the email address?");
          return res.sendStatus(200);
        }

        await pool.query(
          "update scheduling_state set awaiting_email=false, updated_at=now() where client_id=$1 and lead_id=$2",
          [clientId, outLeadId]
        );

        await pool.query(
          `insert into events (client_id, lead_id, type, payload)
           values ($1,$2,'appointment_invite_sent', jsonb_build_object('email',$3::text,'eventId',$4::text))`,
          [clientId, outLeadId, email, eventId]
        );

        return res.sendStatus(200);
      }
    }

    /* ----------------------------- Agenda ----------------------------- */
    if (wantsAppointment(text)) {
      const choice = parseChoice(text);

      // Usuario elige slot (1/2/3)
      if (choice) {
        const { rows: stRows } = await pool.query(
          "select proposed from scheduling_state where client_id=$1 and lead_id=$2",
          [clientId, outLeadId]
        );

        const proposed = stRows[0]?.proposed || [];
        const picked = proposed[choice - 1];

        if (!picked) {
          await sendWhatsAppText(waFrom, "I can't find that slot. Type \"book\" and I'll share new options.");
          return res.sendStatus(200);
        }

        const ev = await createCalendarEvent({
          clientId,
          summary: `Bell Moon Consultation - ${name || waFrom}`,
          description: `Lead ${outLeadId} | WhatsApp ${waFrom}`,
          startISO: picked.startISO,
          endISO: picked.endISO,
        });

        // Recordatorios 24h y 2h antes
        const startAt = new Date(picked.startISO);
        const remind24h = new Date(startAt.getTime() - 24 * 60 * 60 * 1000);
        const remind2h = new Date(startAt.getTime() - 2 * 60 * 60 * 1000);

        await pool.query(
          `insert into appointment_reminders (client_id, lead_id, event_id, start_at, remind_at, kind)
           values
             ($1,$2,$3,$4,$5,'24h'),
             ($1,$2,$3,$4,$6,'2h')
           on conflict do nothing`,
          [clientId, outLeadId, ev.id, startAt.toISOString(), remind24h.toISOString(), remind2h.toISOString()]
        );

        await pool.query(
          `insert into scheduling_state (client_id, lead_id, awaiting_email, last_event, updated_at)
           values ($1,$2,true, jsonb_build_object('eventId',$3::text,'startISO',$4::text,'endISO',$5::text), now())
           on conflict (client_id, lead_id)
           do update set awaiting_email=true, last_event=excluded.last_event, updated_at=now()`,
          [clientId, outLeadId, ev.id, picked.startISO, picked.endISO]
        );

        // Si ya hay email guardado, enviar invitación directamente
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
              `Booked ✅\nStart: ${new Date(picked.startISO).toLocaleString("en-GB", { timeZone: "Europe/London" })}\nDuration: 1 hour\n\nInvitation sent to ${savedEmail}.`
            );
            return res.sendStatus(200);
          } catch (e) {
            console.error("CAL INVITE ERROR ❌", e);
          }
        }

        await sendWhatsAppText(
          waFrom,
          `Booked ✅\nStart: ${new Date(picked.startISO).toLocaleString("en-GB", { timeZone: "Europe/London" })}\nDuration: 1 hour\n\nWhat email should I send the calendar invitation to?`
        );
        return res.sendStatus(200);
      }

      // Proponer huecos disponibles
      const now = new Date();
      const timeMinISO = now.toISOString();
      const timeMax = new Date(now);
      timeMax.setDate(timeMax.getDate() + 7);
      const timeMaxISO = timeMax.toISOString();

      const busy = await getBusyRanges({ clientId, timeMinISO, timeMaxISO });
      const slots = generateSlots1h({ now, days: 7, count: 3, busyRanges: busy });

      if (!slots.length) {
        await sendWhatsAppText(waFrom, "I can't see availability this week. Would next week work for you?");
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
        formatSlots(slots) +
        "\n\nReply with 1, 2, or 3 to book.";

      await sendWhatsAppText(waFrom, msgText);
      return res.sendStatus(200);
    }

    /* ----------------------------- IA normal ----------------------------- */
    let aiReply;
    try {
      aiReply = await generateReply(text, { clientId, leadId: outLeadId });
    } catch (err) {
      console.error("AI ERROR ❌", err);
      aiReply = "Sorry — I can't reply right now. Please try again in a few minutes.";
    }

    await pool.query(
      `insert into events (client_id, lead_id, type, payload)
       values ($1, $2, 'outbound_msg', jsonb_build_object('text', $3::text))`,
      [clientId, outLeadId, aiReply]
    );

    await sendWhatsAppText(waFrom, aiReply);

    // Enviar foto/video si el mensaje menciona un tratamiento
    const treatment = detectTreatmentFromText(text);
    if (treatment && TREATMENT_PHOTOS[treatment]?.length) {
      const photos = TREATMENT_PHOTOS[treatment];
      const picked = photos[Math.floor(Math.random() * photos.length)];
      await sendWhatsAppMedia(waFrom, picked.url, picked.caption);
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error("WEBHOOK ERROR ❌", e);
    return res.sendStatus(200);
  }
});

/* ========================================================================== */
/*                              Privacy Policy                                */
/* ========================================================================== */

app.get("/privacy", (_req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Privacy Policy – Herion</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;line-height:1.6;color:#222}h1{font-size:1.6rem}h2{font-size:1.2rem;margin-top:2rem}</style></head><body>
<h1>Privacy Policy</h1>
<p><strong>Last updated:</strong> April 2026</p>

<h2>1. Introduction</h2>
<p>Herion ("we", "us") operates the Bot-CRM application that provides automated appointment scheduling and customer communication via WhatsApp for our clients' businesses. This policy explains how we collect, use, and protect personal data.</p>

<h2>2. Data We Collect</h2>
<p>We collect only the data necessary to provide our service: phone numbers, names, and messages exchanged via WhatsApp, as well as email addresses provided for calendar invitations.</p>

<h2>3. How We Use Your Data</h2>
<p>Data is used exclusively to: respond to customer inquiries, schedule appointments, send appointment reminders, and manage customer relationships on behalf of the business you contacted.</p>

<h2>4. Data Storage & Security</h2>
<p>Data is stored in encrypted databases hosted on Railway (EU/US). We use industry-standard security measures including HTTPS encryption and access controls.</p>

<h2>5. Data Sharing</h2>
<p>We do not sell personal data. Data may be shared with: Meta (WhatsApp Business API), OpenAI (message processing), and Google (calendar invitations) solely to provide the service.</p>

<h2>6. Data Retention</h2>
<p>We retain conversation data for up to 12 months. You may request deletion of your data at any time.</p>

<h2>7. Your Rights</h2>
<p>You have the right to access, correct, or delete your personal data. To exercise these rights, contact us at: <a href="mailto:pablovillar@herion.es">pablovillar@herion.es</a></p>

<h2>8. Contact</h2>
<p>Herion – pablovillar@herion.es</p>
</body></html>`);
});

/* ========================================================================== */
/*                                   Server                                   */
/* ========================================================================== */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("listening on", PORT));