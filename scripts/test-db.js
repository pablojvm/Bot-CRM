require("dotenv").config();
const pool = require("../db");

(async () => {
  const clientId = "default";
  const phone = "+34600000000";
  const name = "Pablo";
  const text = "Hola, quiero info";

  const r = await pool.query(
    "select * from upsert_inbound_whatsapp($1,$2,$3,$4)",
    [clientId, phone, name, text]
  );

  console.log("OK:", r.rows[0]);
  await pool.end();
})().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});