const express = require('express');
const { startIndexing, startFaceDetection, getIndexingState } = require('../services/indexer');

const router = express.Router();

// Start indexing
router.post('/start', async (req, res) => {
  console.log('POST /start - received request');
  res.json({ status: 'started' });
  console.log('POST /start - response sent');
  startIndexing().catch(err => console.error('Indexing error:', err));
});

// Start face detection
router.post('/faces/start', async (req, res) => {
  console.log('POST /faces/start - received request, body:', req.body);
  const distance = parseFloat(req.body?.distance) || 0.6;
  console.log('Using distance:', distance);
  res.json({ status: 'started' });
  startFaceDetection(distance).catch(err => console.error('Face detection error:', err));
});

// Get indexing state
router.get('/state', async (req, res) => {
  try {
    const state = await getIndexingState();
    res.json(state);
  } catch (err) {
    console.error('Error getting indexing state:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
