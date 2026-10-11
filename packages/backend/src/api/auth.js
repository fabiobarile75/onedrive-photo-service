const express = require('express');
const { getAuthorizationUrl, handleOAuthCallback, hasOneDriveTokens, getValidAccessToken } = require('../auth/oauth');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const FRONTEND_URL = process.env.PHOTOS_FRONTEND_URL || process.env.AUTH_FRONTEND_URL || 'http://localhost:5173';

// Initiate OneDrive OAuth — requires JWT auth
router.get('/onedrive/connect', authMiddleware, (req, res) => {
  const url = getAuthorizationUrl(req.userId);
  res.redirect(url);
});

// OAuth callback — state = userId (set by /onedrive/connect)
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(`${FRONTEND_URL}?onedrive_error=${encodeURIComponent(error)}`);
  }

  if (!code || !state) {
    return res.status(400).send('Missing code or state');
  }

  try {
    await handleOAuthCallback(code, state);
    res.redirect(`${FRONTEND_URL}?onedrive_connected=1`);
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.redirect(`${FRONTEND_URL}?onedrive_error=${encodeURIComponent(err.message)}`);
  }
});

// Check OneDrive connection status — requires JWT auth
router.get('/onedrive/status', authMiddleware, async (req, res) => {
  try {
    const connected = await hasOneDriveTokens(req.userId);
    res.json({ connected });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Disconnect OneDrive — requires JWT auth
router.delete('/onedrive/disconnect', authMiddleware, async (req, res) => {
  try {
    const pool = require('../db/init').getPool();
    await pool.query('DELETE FROM user_onedrive_tokens WHERE user_id = $1', [req.userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Refresh OneDrive token — requires JWT auth
router.post('/onedrive/refresh', authMiddleware, async (req, res) => {
  try {
    await getValidAccessToken(req.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

module.exports = router;
