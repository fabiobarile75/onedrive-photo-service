const express = require('express');
const { getPool } = require('../db/init');
const { getValidAccessToken } = require('../auth/oauth');
const fetch = require('node-fetch').default;

const router = express.Router();

// Get photos with pagination
router.get('/', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const pool = getPool();
    const client = await pool.connect();

    try {
      const result = await client.query(
        `SELECT id, name, taken_at, metadata FROM photos
         ORDER BY taken_at DESC NULLS LAST, created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );

      const countResult = await client.query('SELECT COUNT(*) as count FROM photos');
      const total = parseInt(countResult.rows[0].count);

      res.json({
        photos: result.rows,
        total,
        limit,
        offset
      });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error fetching photos:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get photos by location (GPS)
router.get('/location', async (req, res) => {
  try {
    const { lat, lon, radius = 1 } = req.query;

    if (!lat || !lon) {
      return res.status(400).json({ error: 'lat and lon required' });
    }

    const pool = getPool();
    const client = await pool.connect();

    try {
      const result = await client.query(
        `SELECT id, name, taken_at, metadata FROM photos
         WHERE metadata->'location'->>'latitude' IS NOT NULL
         AND ST_DWithin(
           ST_MakePoint(
             (metadata->'location'->>'longitude')::float,
             (metadata->'location'->>'latitude')::float
           )::geography,
           ST_MakePoint($1::float, $2::float)::geography,
           $3 * 1000
         )
         ORDER BY taken_at DESC`,
        [lon, lat, radius]
      );

      res.json({ photos: result.rows });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error fetching photos by location:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get photos filtered by cluster
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
         JOIN photo_faces pf ON pf.photo_id = p.id
         WHERE pf.person_cluster_id = $1
         ORDER BY p.taken_at DESC NULLS LAST
         LIMIT $2`,
        [clusterId, limit]
      );
      res.json({ photos: result.rows });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error fetching photos by cluster:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get original photo from OneDrive (proxy)
router.get('/:photoId/view', async (req, res) => {
  try {
    const token = await getValidAccessToken();
    const itemRes = await fetch(
      `https://graph.microsoft.com/v1.0/me/drive/items/${req.params.photoId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!itemRes.ok) return res.status(404).json({ error: 'Photo not found' });
    const item = await itemRes.json();
    const downloadUrl = item['@microsoft.graph.downloadUrl'];
    if (!downloadUrl) return res.status(404).json({ error: 'No download URL' });
    res.redirect(downloadUrl);
  } catch (err) {
    console.error('Error fetching photo:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
