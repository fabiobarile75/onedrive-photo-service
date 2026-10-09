const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'onedrive_photos',
});

async function initializeDb() {
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_onedrive_tokens (
        user_id TEXT PRIMARY KEY,
        access_token TEXT,
        refresh_token TEXT NOT NULL,
        expires_at BIGINT,
        scope TEXT,
        token_type TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS photos (
        id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        taken_at TIMESTAMP,
        metadata JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id, user_id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS photo_faces (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        photo_id TEXT NOT NULL,
        face_index INT NOT NULL,
        bounding_box JSONB NOT NULL,
        descriptor BYTEA NOT NULL,
        age INT,
        gender TEXT,
        expressions JSONB,
        thumbnail BYTEA,
        person_cluster_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS person_clusters (
        id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        name TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id, user_id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS indexing_state (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'idle',
        total_items INT DEFAULT 0,
        processed_items INT DEFAULT 0,
        current_page INT DEFAULT 0,
        error TEXT,
        started_at TIMESTAMP,
        completed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Indexes
    await client.query(`CREATE INDEX IF NOT EXISTS idx_photos_user_taken_at ON photos(user_id, taken_at DESC);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_photo_faces_user_id ON photo_faces(user_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_photo_faces_photo_id ON photo_faces(photo_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_photo_faces_cluster_id ON photo_faces(person_cluster_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_indexing_state_user_id ON indexing_state(user_id);`);

    // Migrations for existing installations
    await client.query(`ALTER TABLE photos ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT '';`);
    await client.query(`ALTER TABLE photo_faces ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT '';`);
    await client.query(`ALTER TABLE person_clusters ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT '';`);
    await client.query(`ALTER TABLE indexing_state ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT '';`);

    console.log('Database initialized successfully');
  } finally {
    client.release();
  }
}

function getPool() {
  return pool;
}

module.exports = { initializeDb, getPool };
