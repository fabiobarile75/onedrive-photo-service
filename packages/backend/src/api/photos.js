const express = require('express');
const { getPool } = require('../db/init');
const { getValidAccessToken } = require('../auth/oauth');
const fetch = require('node-fetch').default;

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const pool = getPool();
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT id, name, taken_at, metadata FROM photos
         WHERE user_id = $1
         ORDER BY taken_at DESC NULLS LAST, created_at DESC
         LIMIT $2 OFFSET $3`,
        [req.userId, limit, offset]
      );
      const countResult = await client.query('SELECT COUNT(*) as count FROM photos WHERE user_id = $1', [req.userId]);
      res.json({ photos: result.rows, total: parseInt(countResult.rows[0].count), limit, offset });
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/map', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radius = parseFloat(req.query.radius) || 10; // km
    const personIds = req.query.personIds ? req.query.personIds.split(',').filter(Boolean) : null;
    const limit = parseInt(req.query.limit) || 500;

    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ error: 'lat and lng are required' });
    }

    const pool = getPool();
    const client = await pool.connect();
    try {
      // Haversine distance filter using GPS coords from metadata JSONB
      // Graph API stores: metadata->'location' = { latitude, longitude, altitude }
      let query, params;

      if (personIds && personIds.length > 0) {
        query = `
          SELECT DISTINCT ON (p.id) p.id, p.name, p.taken_at,
                 (p.metadata->'location'->>'latitude')::float  AS lat,
                 (p.metadata->'location'->>'longitude')::float AS lng,
                 (6371 * acos(LEAST(1.0,
                   cos(radians($1)) * cos(radians((p.metadata->'location'->>'latitude')::float)) *
                   cos(radians((p.metadata->'location'->>'longitude')::float) - radians($2)) +
                   sin(radians($1)) * sin(radians((p.metadata->'location'->>'latitude')::float))
                 ))) AS distance_km
          FROM photos p
          JOIN photo_faces pf ON pf.photo_id = p.id AND pf.user_id = p.user_id
          WHERE p.user_id = $3
            AND p.metadata->'location' IS NOT NULL
            AND p.metadata->'location'->>'latitude' IS NOT NULL
            AND pf.person_cluster_id = ANY($4::text[])
            AND (6371 * acos(LEAST(1.0,
                   cos(radians($1)) * cos(radians((p.metadata->'location'->>'latitude')::float)) *
                   cos(radians((p.metadata->'location'->>'longitude')::float) - radians($2)) +
                   sin(radians($1)) * sin(radians((p.metadata->'location'->>'latitude')::float))
                 ))) <= $5
          ORDER BY p.id, distance_km ASC
          LIMIT $6`;
        params = [lat, lng, req.userId, personIds, radius, limit];
      } else {
        query = `
          SELECT p.id, p.name, p.taken_at,
                 (p.metadata->'location'->>'latitude')::float  AS lat,
                 (p.metadata->'location'->>'longitude')::float AS lng,
                 (6371 * acos(LEAST(1.0,
                   cos(radians($1)) * cos(radians((p.metadata->'location'->>'latitude')::float)) *
                   cos(radians((p.metadata->'location'->>'longitude')::float) - radians($2)) +
                   sin(radians($1)) * sin(radians((p.metadata->'location'->>'latitude')::float))
                 ))) AS distance_km
          FROM photos p
          WHERE p.user_id = $3
            AND p.metadata->'location' IS NOT NULL
            AND p.metadata->'location'->>'latitude' IS NOT NULL
            AND (6371 * acos(LEAST(1.0,
                   cos(radians($1)) * cos(radians((p.metadata->'location'->>'latitude')::float)) *
                   cos(radians((p.metadata->'location'->>'longitude')::float) - radians($2)) +
                   sin(radians($1)) * sin(radians((p.metadata->'location'->>'latitude')::float))
                 ))) <= $4
          ORDER BY distance_km ASC
          LIMIT $5`;
        params = [lat, lng, req.userId, radius, limit];
      }

      const result = await client.query(query, params);
      res.json({ photos: result.rows, count: result.rows.length });
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


router.get('/by-cluster/:clusterId', async (req, res) => {
  try {
    const { clusterId } = req.params;
    const limit = parseInt(req.query.limit) || 100;
    const pool = getPool();
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT DISTINCT p.id, p.name, p.taken_at,
                encode(pf.thumbnail, 'base64') as face_thumbnail
         FROM photos p
         JOIN photo_faces pf ON pf.photo_id = p.id AND pf.user_id = p.user_id
         WHERE pf.person_cluster_id = $1 AND p.user_id = $2
         ORDER BY p.taken_at DESC NULLS LAST
         LIMIT $3`,
        [clusterId, req.userId, limit]
      );
      res.json({ photos: result.rows });
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:photoId/thumbnail', async (req, res) => {
  try {
    const token = await getValidAccessToken(req.userId);
    const imgRes = await fetch(
      `https://graph.microsoft.com/v1.0/me/drive/items/${req.params.photoId}/thumbnails/0/small/content`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!imgRes.ok) return res.status(404).end();
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=3600');
    imgRes.body.pipe(res);
  } catch (err) {
    res.status(500).end();
  }
});

router.get('/:photoId/view', async (req, res) => {
  try {
    const token = await getValidAccessToken(req.userId);
    const imgRes = await fetch(
      `https://graph.microsoft.com/v1.0/me/drive/items/${req.params.photoId}/thumbnails/0/large/content`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!imgRes.ok) return res.status(404).json({ error: 'Photo not found' });
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=3600');
    imgRes.body.pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
