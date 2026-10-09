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

router.get('/:photoId/view', async (req, res) => {
  try {
    const token = await getValidAccessToken(req.userId);
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
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
