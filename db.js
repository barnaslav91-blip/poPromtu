const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
const isLocal = !connectionString || /localhost|127\.0\.0\.1/.test(connectionString);

const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS videos (
      id SERIAL PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      youtube_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS reviewers (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS comments (
      id SERIAL PRIMARY KEY,
      video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      reviewer_name TEXT NOT NULL,
      timestamp_seconds INTEGER NOT NULL,
      text TEXT NOT NULL,
      resolved BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS promo_clients (
      id SERIAL PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      service TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      price_from TEXT NOT NULL DEFAULT '',
      price_per_lead NUMERIC(10, 2) NOT NULL DEFAULT 0,
      posts_per_day INTEGER NOT NULL DEFAULT 3,
      dedup_days INTEGER NOT NULL DEFAULT 30,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS promo_groups (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL REFERENCES promo_clients(id) ON DELETE CASCADE,
      network TEXT NOT NULL DEFAULT 'facebook',
      name TEXT NOT NULL,
      url TEXT NOT NULL DEFAULT '',
      min_interval_days INTEGER NOT NULL DEFAULT 7,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS promo_templates (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL REFERENCES promo_clients(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS promo_images (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL REFERENCES promo_clients(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      caption TEXT NOT NULL DEFAULT '',
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS promo_posts (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL REFERENCES promo_clients(id) ON DELETE CASCADE,
      group_id INTEGER NOT NULL REFERENCES promo_groups(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      combo_key TEXT NOT NULL DEFAULT '',
      image_id INTEGER REFERENCES promo_images(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'planned',
      scheduled_for DATE NOT NULL DEFAULT CURRENT_DATE,
      posted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS promo_leads (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL REFERENCES promo_clients(id) ON DELETE CASCADE,
      group_id INTEGER REFERENCES promo_groups(id) ON DELETE SET NULL,
      name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      phone_key TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new',
      reject_reason TEXT NOT NULL DEFAULT '',
      is_duplicate BOOLEAN NOT NULL DEFAULT false,
      price NUMERIC(10, 2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    ALTER TABLE promo_leads ADD COLUMN IF NOT EXISTS phone_key TEXT NOT NULL DEFAULT '';

    -- Картинка либо лежит по внешней ссылке (url), либо загружена в базу (data).
    -- Диск на free-плане Render не переживает перезапуск, поэтому файлы — в Postgres.
    ALTER TABLE promo_images ADD COLUMN IF NOT EXISTS data BYTEA;
    ALTER TABLE promo_images ADD COLUMN IF NOT EXISTS mime TEXT NOT NULL DEFAULT '';
    ALTER TABLE promo_images ADD COLUMN IF NOT EXISTS filename TEXT NOT NULL DEFAULT '';
    ALTER TABLE promo_images ALTER COLUMN url SET DEFAULT '';

    ALTER TABLE promo_clients ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT NOT NULL DEFAULT '';

    -- Реквизиты для акта оказанных услуг.
    ALTER TABLE promo_clients ADD COLUMN IF NOT EXISTS contract_number TEXT NOT NULL DEFAULT '';
    ALTER TABLE promo_clients ADD COLUMN IF NOT EXISTS contract_date TEXT NOT NULL DEFAULT '';
    ALTER TABLE promo_clients ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'MDL';
    ALTER TABLE promo_clients ADD COLUMN IF NOT EXISTS vat_percent NUMERIC(5, 2) NOT NULL DEFAULT 0;

    CREATE INDEX IF NOT EXISTS promo_posts_group_idx
      ON promo_posts (group_id, status, posted_at DESC);
    CREATE INDEX IF NOT EXISTS promo_leads_client_idx
      ON promo_leads (client_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS promo_leads_phone_idx
      ON promo_leads (client_id, phone_key);
  `);
}

module.exports = { pool, init };
