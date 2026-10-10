const express = require('express');
const { startIndexing, startFaceDetection, getIndexingState, getFaceDetectionState, getFaceDetectionMetrics } = require('../services/indexer');

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
  res.json({ status: 'started' });
  startFaceDetection(req.userId, distance, model, limit, concurrency).catch(err => console.error('Face detection error:', err));
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
    res.json(state);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/faces/metrics', async (req, res) => {
  const metrics = getFaceDetectionMetrics(req.userId);
  res.json(metrics);
});

module.exports = router;
