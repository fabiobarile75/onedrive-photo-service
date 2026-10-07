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
    // Create tables directly in current database
    // Create photos table
    await client.query(`
      CREATE TABLE IF NOT EXISTS photos (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        taken_at TIMESTAMP,
        metadata JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create photo_faces table
    await client.query(`
      CREATE TABLE IF NOT EXISTS photo_faces (
        id SERIAL PRIMARY KEY,
        photo_id TEXT REFERENCES photos(id) ON DELETE CASCADE,
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

    // Create indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_photos_taken_at ON photos(taken_at DESC);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_photo_faces_photo_id ON photo_faces(photo_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_photo_faces_cluster_id ON photo_faces(person_cluster_id);
    `);

    // Create indexing state table
    await client.query(`
      CREATE TABLE IF NOT EXISTS indexing_state (
        id SERIAL PRIMARY KEY,
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

    console.log('Database initialized successfully');
  } finally {
    client.release();
  }
}

function getPool() {
  return pool;
}

module.exports = { initializeDb, getPool };
