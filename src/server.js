require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");
const { google } = require("googleapis");
const pool = require("../db");

const app = express();
app.use(express.json({ type: "*/*" }));

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

OBJETIVO
1) Entender la intención del cliente.
2) Resolver dudas rápidas.
3) Si la intención es compatible con una cita (o el usuario lo sugiere), guiar a agendar.

INTENCIONES (clasifica mentalmente)
- INFO: pide información general (servicios, precios, horarios, ubicación, proceso).
- SOPORTE: problema o incidencia.
- CITA: quiere reservar, ver disponibilidad, cambiar/cancelar
- OTRO: no encaja.

REGLAS PARA EMPUJAR A CITA (cuando ya tengas la intención)
- Si CITA: ofrece directamente agendar y pide disponibilidad si hace falta.
- Si INFO o SOPORTE y notas interés claro (pregunta por precio + “quiero” / “me interesa” / “cuando puedo” / “hablar”): propone cita.
- No presiones: una pregunta y opciones.

DATOS A PEDIR PARA CITA (solo los mínimos)
- Motivo (si no está claro).
- Preferencia de día (hoy/mañana/esta semana) y franja (mañana/tarde) o confirma si vale cualquier hora.
- Nombre (si no lo tenemos) y confirmación de teléfono si hiciera falta.

IMPORTANTE SOBRE LA AGENDA
- Si el usuario quiere cita, tu respuesta debe terminar con una pregunta concreta para avanzar (por ejemplo: “¿Te va mejor mañana por la mañana o por la tarde?”).
- Si el usuario ya te da un día/hora, confirma y pide solo lo que falte.
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

        const dow = day.getDay(); // 0 dom, 6 sáb
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
/*                               Meta Webhook GET                              */
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
/*                               Meta Webhook POST                             */
/* ========================================================================== */

app.post("/webhook", async (req, res) => {
    try {
        const body = req.body;

        if (body?.object !== "whatsapp_business_account") return res.sendStatus(200);

        const change = body.entry?.[0]?.changes?.[0]?.value;
        const msg = change?.messages?.[0];
        if (!msg) return res.sendStatus(200);

        const phone = msg.from;
        const text = msg.text?.body || "";
        const name = change?.contacts?.[0]?.profile?.name || null;

        const waFrom = phone ? `+${phone}` : null;
        const clientId = "default";

        // 1) Guardar inbound + asegurar lead
        const r = await pool.query("select * from upsert_inbound_whatsapp($1,$2,$3,$4)", [
            clientId,
            waFrom,
            name,
            text,
        ]);

        const outLeadId = r.rows?.[0]?.out_lead_id;
        if (!outLeadId) return res.sendStatus(200);

        // 2) Agenda (1h)
        if (wantsAppointment(text)) {
            const choice = parseChoice(text);

            // 2a) Si el usuario elige 1/2/3 => reservar
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
                    `Perfecto ✅ Cita reservada.\n` +
                    `Inicio: ${new Date(picked.startISO).toLocaleString("es-ES", { timeZone: "Europe/Madrid" })}\n` +
                    `Duración: 1 hora`;

                await sendWhatsAppText(waFrom, confirm);
                return res.sendStatus(200);
            }

            // 2b) Si no elige => proponer huecos
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
                "Claro. Tengo estos huecos (1 hora):\n" +
                formatSlotsES(slots) +
                "\n\nResponde con 1, 2 o 3 para reservar.";

            await sendWhatsAppText(waFrom, msgText);
            return res.sendStatus(200);
        }

        // 3) Respuesta normal IA
        let aiReply;
        try {
            aiReply = await generateReply(text);
        } catch (err) {
            console.error("AI ERROR ❌", err);
            aiReply = "Ahora mismo no puedo responder, inténtalo en unos minutos.";
        }

        // 4) Guardar outbound
        await pool.query(
            `insert into events (client_id, lead_id, type, payload)
       values ($1, $2, 'outbound_msg', jsonb_build_object('text', $3::text))`,
            [clientId, outLeadId, aiReply]
        );

        // 5) Enviar WhatsApp
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