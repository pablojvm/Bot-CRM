// db.js
const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.PGHOST_PUBLIC,
  port: Number(process.env.PGPORT_PUBLIC),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  ssl: { rejectUnauthorized: false },
});

module.exports = pool;