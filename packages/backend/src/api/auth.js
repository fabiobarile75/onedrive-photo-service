const express = require('express');
const { getValidAccessToken, startLoginFlow } = require('../auth/oauth');

const router = express.Router();

// Refresh token endpoint
router.post('/refresh', async (req, res) => {
  try {
    const token = await getValidAccessToken();
    res.json({ success: true, message: 'Token refreshed successfully' });
  } catch (err) {
    console.error('Token refresh error:', err);
    res.status(401).json({ error: 'Token refresh failed', details: err.message });
  }
});

// Check token validity
router.get('/status', async (req, res) => {
  try {
    const token = await getValidAccessToken();
    res.json({ authenticated: true, message: 'Token is valid' });
  } catch (err) {
    res.status(401).json({ authenticated: false, error: err.message });
  }
});

// Start login flow (opens browser for OAuth)
router.get('/login', async (req, res) => {
  try {
    // In real implementation, this would start the OAuth flow
    // For now, just indicate to the user they need to run the login script
    res.json({
      message: 'Please run: npm run login --workspace=packages/backend',
      loginUrl: 'http://localhost:3333'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
