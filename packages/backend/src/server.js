const express = require('express');
const path = require('path');
const { getValidAccessToken } = require('./auth/oauth');
const { initializeDb } = require('./db/init');
const { authMiddleware } = require('./middleware/auth');
const indexingRouter = require('./api/indexing');
const photosRouter = require('./api/photos');
const facesRouter = require('./api/faces');
const authRouter = require('./api/auth');

const app = express();
const PORT = process.env.PORT || 8000;

app.use(express.json());

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Auth routes — /callback is public, others use authMiddleware internally
app.use('/api/auth', authRouter);

// All other API routes require JWT
app.use('/api', authMiddleware);
app.use('/api/indexing', indexingRouter);
app.use('/api/photos', photosRouter);
app.use('/api/faces', facesRouter);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Serve frontend static files in production
const frontendDist = process.env.FRONTEND_DIST || '/app/web/dist';
if (require('fs').existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
}

async function startServer() {
  try {
    console.log('Starting server...');
    console.log('Initializing database...');
    await initializeDb();
    console.log('Database initialized');

    // Reset any stuck face detection jobs from previous run
    const { getPool } = require('./db/init');
    await getPool().query(
      `UPDATE face_detection_state SET status = 'error', error = 'Server restarted'
       WHERE status IN ('indexing', 'clustering')`
    );

    app.listen(PORT, () => {
      console.log(`✓ Backend running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

startServer();
