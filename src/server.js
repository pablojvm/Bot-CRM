require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");
const pool = require("../db");

const app = express();

// Body parser (Meta manda JSON)
app.use(express.json({ type: "*/*" }));

// OpenAI client
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

async function generateReply(userMessage) {
    const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
            {
                role: "system",
                content: `
Eres el asistente de Herion.
Habla profesional, breve y claro.
Detecta si el usuario quiere agendar cita.
No inventes información.
`,
            },
            { role: "user", content: userMessage },
        ],
    });

    return response.choices[0].message.content;
}

// Health
app.get("/health", (req, res) => res.status(200).send("ok"));

// DB test
app.get("/db-test", async (req, res) => {
    try {
        const r = await pool.query("select now()");
        res.json(r.rows[0]);
    } catch (e) {
        console.error(e);
        res.status(500).send("db error");
    }
});

// AI test
app.get("/ai-test", async (req, res) => {
    try {
        const reply = await generateReply("Hola, quiero información");
        res.send(reply);
    } catch (e) {
        console.error(e);
        res.status(500).send("AI error");
    }
});

// Meta webhook verification (GET)
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

async function sendWhatsAppText(to, message) {
  const url = `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.WHATSAPP_TOKEN}`,
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

  if (!response.ok) {
    console.error("WHATSAPP SEND ERROR ❌", data);
  } else {
    console.log("WHATSAPP SENT ✅", data);
  }

  return data;
}

// Meta webhook receiver (POST)
app.post("/webhook", async (req, res) => {
  try {
    console.log("WEBHOOK HIT ✅");

    const body = req.body;

    if (body?.object !== "whatsapp_business_account") {
      return res.sendStatus(200);
    }

    const change = body.entry?.[0]?.changes?.[0]?.value;
    const msg = change?.messages?.[0];

    if (!msg) {
      return res.sendStatus(200);
    }

    const phone = msg.from;
    const text = msg.text?.body || "";
    const name = change?.contacts?.[0]?.profile?.name || null;

    const waFrom = phone ? `+${phone}` : null;
    const clientId = "default";

    // 1️⃣ Guardar inbound + asegurar lead
    const r = await pool.query(
      "select * from upsert_inbound_whatsapp($1,$2,$3,$4)",
      [clientId, waFrom, name, text]
    );

    const outLeadId = r.rows?.[0]?.out_lead_id;
    if (!outLeadId) {
      console.log("No lead_id returned");
      return res.sendStatus(200);
    }

    console.log("DB UPSERT OK ✅", r.rows[0]);

    // 2️⃣ Generar respuesta IA
    let aiReply;
    try {
      aiReply = await generateReply(text);
      console.log("AI OK ✅", aiReply);
    } catch (err) {
      console.error("AI ERROR ❌", err);
      aiReply = "Ahora mismo no puedo responder, inténtalo en unos minutos.";
    }

    // 3️⃣ Guardar outbound correctamente tipado
    await pool.query(
      `
      insert into events (client_id, lead_id, type, payload)
      values (
        $1,
        $2,
        'outbound_msg',
        jsonb_build_object('text', $3::text)
      )
      `,
      [clientId, outLeadId, aiReply]
    );

    console.log("OUTBOUND SAVED ✅");

    await sendWhatsAppText(waFrom, aiReply);

    return res.sendStatus(200);
  } catch (e) {
    console.error("WEBHOOK ERROR ❌", e);
    return res.sendStatus(200);
  }
});



const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("listening on", PORT));