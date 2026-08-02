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

    CREATE TABLE IF NOT EXISTS meet_profiles (
      id SERIAL PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      about TEXT NOT NULL DEFAULT '',
      lat DOUBLE PRECISION,
      lon DOUBLE PRECISION,
      location_updated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS meets (
      id SERIAL PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      host_id INTEGER NOT NULL REFERENCES meet_profiles(id) ON DELETE CASCADE,
      activity TEXT NOT NULL,
      place TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      lat DOUBLE PRECISION NOT NULL,
      lon DOUBLE PRECISION NOT NULL,
      starts_at TIMESTAMPTZ NOT NULL,
      max_people INTEGER NOT NULL DEFAULT 4,
      canceled BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS meets_starts_at_idx ON meets (starts_at);

    CREATE TABLE IF NOT EXISTS meet_participants (
      meet_id INTEGER NOT NULL REFERENCES meets(id) ON DELETE CASCADE,
      profile_id INTEGER NOT NULL REFERENCES meet_profiles(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (meet_id, profile_id)
    );

    CREATE TABLE IF NOT EXISTS meet_messages (
      id SERIAL PRIMARY KEY,
      meet_id INTEGER NOT NULL REFERENCES meets(id) ON DELETE CASCADE,
      profile_id INTEGER NOT NULL REFERENCES meet_profiles(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS meet_reports (
      id SERIAL PRIMARY KEY,
      meet_id INTEGER NOT NULL REFERENCES meets(id) ON DELETE CASCADE,
      profile_id INTEGER NOT NULL REFERENCES meet_profiles(id) ON DELETE CASCADE,
      reason TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (meet_id, profile_id)
    );
  `);
}

module.exports = { pool, init };
