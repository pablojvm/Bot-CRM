require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");
const { google } = require("googleapis");
const pool = require("../db");

const app = express();
app.use(express.json({ type: "*/*" }));

const INVOICE_URL = "https://guibear0.github.io/Facturas_generator/";

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
Eres el asistente oficial de Herion. Atiendes por WhatsApp.

ESTILO
- Tono corporativo, cercano y profesional.
- Respuestas breves y claras (1–4 frases).
- Español de España.
- No inventes información. Si falta un dato, pregunta.
- Si el usuario saluda, responde con un saludo corporativo y ofrece ayuda.

PRODUCTOS DISPONIBLES (menciónalos solo si encajan con lo que pide)
- Generador de facturas
- Generador de horarios/turnos
- Asistente virtual con IA
- OCR / CRM propio
- Automatizaciones personalizadas
- Bots de whatsapp

OBJETIVO
1) Identificar la intención del cliente (qué necesita).
2) Recomendar el producto adecuado (si aplica).
3) Cuando haya interés real, guiar hacia agendar una llamada.

INTENCIONES (clasifica mentalmente)
- INFO: información general o curiosidad
- NECESIDAD: describe un problema/objetivo (quiere solución)
- CITA: quiere reservar / ver disponibilidad / cambiar / cancelar
- SOPORTE: incidencia técnica
- OTRO

REGLAS PARA CERRAR CON CITA
- Si CITA: ofrece agendar directamente.
- Si NECESIDAD: recomienda 1 producto y propone llamada para aterrizar el caso.
- Si preguntan por precio: indica que depende del alcance y propone llamada.
- Haz una sola pregunta por mensaje para avanzar.

DATOS A PEDIR (mínimos)
- Qué quiere lograr / para qué lo necesita.
- Si aplica: volumen aproximado (ej. nº facturas/mes, nº turnos, nº clientes).
- Disponibilidad: esta semana (mañana/tarde) o propone cita si el usuario lo pide.

IMPORTANTE
- Si el usuario muestra interés, termina con una pregunta concreta para avanzar.
`.trim(),
      },
      { role: "user", content: userMessage },
    ],
  });

  return response.choices?.[0]?.message?.content || "Vale, ¿en qué te ayudo?";
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

/* ========================================================================== */
/*                           Google Calendar + OAuth                           */
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

// N huecos de 1h entre 10:00-19:00 (lun-vie)
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

function wantsAppointment(text = "") {
  const t = text.toLowerCase();
  return /(cita|reserv|agenda|agendar|turno|hueco|disponibil|mañana|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo|\b\d{1,2}:\d{2}\b|\b\d{1,2}\b)/.test(
    t
  );
}

function parseChoice(text = "") {
  const m = text.trim().match(/^([1-3])\b/);
  return m ? Number(m[1]) : null;
}

function wantsInvoice(text = "") {
  return /(factura|facturación|facturacion|iva|pdf|cobro|pago)/i.test(text);
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
    const reply = await generateReply("Hola, quiero información");
    res.send(reply);
  } catch (e) {
    console.error(e);
    res.status(500).send("AI error");
  }
});

/* ========================================================================== */
/*                               Meta Webhook GET                             */
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

async function runFollowups() {
  const clientId = "default";

  // 1) Coger candidatos vencidos (limit por seguridad)
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
    // 2) “Lock” optimista: solo procesa si sigue vencido y activo
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

    if (lock.rowCount === 0) continue; // otro proceso ya lo pilló

    // 3) Mensaje (simple). Luego lo afinamos con prompt/plantillas.
    const msg =
      `Hola${f.name ? `, ${f.name}` : ""}. ` +
      `¿Quieres que te ayude a agendar una cita o prefieres que te pase información por aquí?`;

    // 4) Enviar WhatsApp
    await sendWhatsAppText(f.wa_from, msg);

    // 5) Guardar evento outbound
    await pool.query(
      `
      insert into events (client_id, lead_id, type, payload)
      values ($1, $2, 'followup_sent', jsonb_build_object('step', $3::int, 'text', $4::text))
      `,
      [f.client_id, f.lead_id, f.step, msg]
    );

    // 6) Programar siguiente paso (1 hora) o desactivar si quieres solo 1 toque
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

// Endpoint “cron” protegido por token
app.get("/cron/followups", async (req, res) => {
  try {
    const token = req.query.token;
    if (!token || token !== process.env.CRON_TOKEN) {
      return res.status(401).send("unauthorized");
    }

    const result = await runFollowups();
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error("CRON FOLLOWUPS ERROR ❌", e);
    res.status(500).json({ ok: false });
  }
});

/* ========================================================================== */
/*                               Meta Webhook POST                            */
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

    // Dedupe: evita dobles respuestas/citas por reintentos de Meta
    if (messageId) {
      const dedupe = await pool.query(
        "insert into inbound_dedupe (client_id, message_id) values ($1,$2) on conflict do nothing",
        [clientId, messageId]
      );
      if (dedupe.rowCount === 0) {
        console.log("DUPLICATE MESSAGE SKIPPED ✅", messageId);
        return res.sendStatus(200);
      }
    }

    const phone = msg.from;
    const text = msg.text?.body || "";
    const name = change?.contacts?.[0]?.profile?.name || null;
    const waFrom = phone ? `+${phone}` : null;

    // Guardar inbound + conseguir lead_id
    const r = await pool.query("select * from upsert_inbound_whatsapp($1,$2,$3,$4)", [
      clientId,
      waFrom,
      name,
      text,
    ]);

    const outLeadId = r.rows?.[0]?.out_lead_id;
    if (!outLeadId) return res.sendStatus(200);

   // FACTURAS: si pide factura
if (wantsInvoice(text)) {
  const leadPerm = await pool.query("select can_invoice from leads where id = $1", [outLeadId]);
  const canInvoice = leadPerm.rows?.[0]?.can_invoice === true;

  // ✅ Cliente reconocido: mandar enlace
  if (canInvoice) {
    await sendWhatsAppText(
      waFrom,
      `Hola${name ? `, ${name}` : ""}. Aquí tienes el enlace para generar facturas:\n${INVOICE_URL}`
    );
    return res.sendStatus(200);
  }

  // ❌ No reconocido: ofrecer cita para contratar el servicio (usa agenda real)
  const now = new Date();
  const timeMinISO = now.toISOString();
  const timeMax = new Date(now);
  timeMax.setDate(timeMax.getDate() + 7);
  const timeMaxISO = timeMax.toISOString();

  const busy = await getBusyRanges({ clientId, timeMinISO, timeMaxISO });
  const slots = generateSlots1h({ now, days: 7, count: 3, busyRanges: busy });

  if (!slots.length) {
    await sendWhatsAppText(
      waFrom,
      "Puedo ayudarte con el generador de facturas. Esta semana no veo huecos disponibles. ¿Te va bien la semana que viene?"
    );
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
    "Puedo ayudarte a activar el generador de facturas para tu negocio.\n" +
    "Tengo estos huecos para una llamada (1 hora):\n" +
    formatSlotsES(slots) +
    "\n\nResponde con 1, 2 o 3 para reservar.";

  await sendWhatsAppText(waFrom, msgText);
  return res.sendStatus(200);
}

    // AGENDA (1h)
    if (wantsAppointment(text)) {
      const choice = parseChoice(text);

      // Elegir 1/2/3 => reservar
      if (choice) {
        const { rows: stRows } = await pool.query(
          "select proposed from scheduling_state where client_id=$1 and lead_id=$2",
          [clientId, outLeadId]
        );

        const proposed = stRows[0]?.proposed || [];
        const picked = proposed[choice - 1];

        if (!picked) {
          await sendWhatsAppText(
            waFrom,
            "No encuentro esos huecos. Te propongo otros ahora mismo: escribe “cita”."
          );
          return res.sendStatus(200);
        }

        const ev = await createCalendarEvent({
          clientId,
          summary: `Cita Herion - ${name || waFrom}`,
          description: `Lead ${outLeadId} | WhatsApp ${waFrom}`,
          startISO: picked.startISO,
          endISO: picked.endISO,
        });

        await pool.query(
          `
          insert into events (client_id, lead_id, type, payload)
          values (
            $1,
            $2,
            'calendar_event_created',
            jsonb_build_object(
              'eventId', $3::text,
              'start',  $4::text,
              'end',    $5::text
            )
          )
          `,
          [clientId, outLeadId, ev.id, picked.startISO, picked.endISO]
        );

        const confirm =
          `Perfecto. Cita reservada.\n` +
          `Inicio: ${new Date(picked.startISO).toLocaleString("es-ES", { timeZone: "Europe/Madrid" })}\n` +
          `Duración: 1 hora`;

        await sendWhatsAppText(waFrom, confirm);
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
        await sendWhatsAppText(
          waFrom,
          "Ahora mismo no veo huecos disponibles esta semana. ¿Te va bien la semana que viene?"
        );
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
        "Perfecto. Tengo estos huecos (1 hora):\n" +
        formatSlotsES(slots) +
        "\n\nResponde con 1, 2 o 3 para reservar.";

      await sendWhatsAppText(waFrom, msgText);
      return res.sendStatus(200);
    }

    // Respuesta normal IA
    let aiReply;
    try {
      aiReply = await generateReply(text);
    } catch (err) {
      console.error("AI ERROR ❌", err);
      aiReply = "Ahora mismo no puedo responder, inténtalo en unos minutos.";
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