const express = require('express');
const { startIndexing, startFaceDetection, resumeFaceDetection, stopFaceDetection, getIndexingState, getFaceDetectionState, getFaceDetectionMetrics } = require('../services/indexer');

const router = express.Router();

router.post('/start', async (req, res) => {
  res.json({ status: 'started' });
  startIndexing(req.userId).catch(err => console.error('Indexing error:', err));
});

router.post('/faces/start', async (req, res) => {
  const distance = parseFloat(req.body?.distance) || 1.0;
  const model = ['hog', 'cnn', 'mediapipe', 'mtcnn'].includes(req.body?.model) ? req.body.model : 'hog';
  const limit = parseInt(req.body?.limit) || 100;
  const concurrency = Math.min(Math.max(parseInt(req.body?.concurrency) || 5, 1), 20);
  const autoRetry = req.body?.autoRetry === true;
  res.json({ status: 'started' });
  startFaceDetection(req.userId, distance, model, limit, concurrency, autoRetry).catch(err => console.error('Face detection error:', err));
});

router.get('/state', async (req, res) => {
  try {
    const state = await getIndexingState(req.userId);
    res.json(state);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/faces/state', async (req, res) => {
  try {
    const state = await getFaceDetectionState(req.userId);
    
    // Ajouter le nombre d'erreurs 429 depuis la table photos
    const pool = require('../db/init').getPool();
    const errorCount = await pool.query(
      `SELECT COUNT(*) as count FROM photos 
       WHERE user_id = $1 AND face_error LIKE '%429%'`,
      [req.userId]
    );
    
    res.json({
      ...state,
      error_429_count: parseInt(errorCount.rows[0].count) || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/faces/metrics', async (req, res) => {
  const metrics = getFaceDetectionMetrics(req.userId);
  res.json(metrics);
});

router.post('/faces/reset', async (req, res) => {
  try {
    const pool = require('../db/init').getPool();
    
    // Réinitialiser l'état de détection
    await pool.query(
      `UPDATE face_detection_state SET status = 'idle', processed_items = 0, error = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE status != 'completed'`
    );

    // Supprimer les faces déjà détectées pour permettre un nouveau traitement
    await pool.query('DELETE FROM photo_faces');
    await pool.query('DELETE FROM person_clusters');

    // Réinitialiser les photos en erreur
    await pool.query(
      `UPDATE photos SET face_error = NULL, face_retries = 0, updated_at = CURRENT_TIMESTAMP
       WHERE face_error IS NOT NULL`
    );

    res.json({ status: 'reset', message: 'Face detection state reset successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/faces/resume', async (req, res) => {
  const distance = parseFloat(req.body?.distance) || 1.0;
  const model = ['hog', 'cnn', 'mediapipe', 'mtcnn'].includes(req.body?.model) ? req.body.model : 'hog';
  const limit = parseInt(req.body?.limit) || 100;
  const concurrency = Math.min(Math.max(parseInt(req.body?.concurrency) || 5, 1), 20);
  const autoRetry = req.body?.autoRetry === true;
  
  res.json({ status: 'resumed' });
  resumeFaceDetection(req.userId, distance, model, limit, concurrency, autoRetry).catch(err => console.error('Face detection resume error:', err));
});

router.post('/faces/stop', async (req, res) => {
  try {
    await stopFaceDetection(req.userId);
    res.json({ status: 'stopped', message: 'Face detection stopped successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/faces/pending', async (req, res) => {
  try {
    const pool = require('../db/init').getPool();
    
    // Photos en erreur
    const errorPhotos = await pool.query(
      `SELECT id, name, face_retries FROM photos 
       WHERE face_error IS NOT NULL AND face_retries < 5
       ORDER BY face_retries DESC, updated_at`
    );

    // Photos non encore traitées
    const pendingPhotos = await pool.query(
      `SELECT id, name FROM photos 
       WHERE face_processed_at IS NULL
       ORDER BY taken_at`
    );

    res.json({
      error_photos: errorPhotos.rows,
      pending_photos: pendingPhotos.rows,
      total_error: errorPhotos.rows.length,
      total_pending: pendingPhotos.rows.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
