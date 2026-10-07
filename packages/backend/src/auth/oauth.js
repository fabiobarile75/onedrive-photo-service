const fs = require('fs');
const path = require('path');

const CLIENT_ID = process.env.OAUTH_CLIENT_ID || 'REDACTED_CLIENT_ID';
const CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || 'REDACTED_SECRET';
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:3000/api/auth/callback';
const SCOPES = 'offline_access Files.Read';
const TOKEN_FILE = path.join(__dirname, '../../tokens.json');
const AUTHORITY = 'https://login.microsoftonline.com/consumers';

function saveTokens(tokens) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

function loadTokens() {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
}

async function refreshAccessToken(refreshToken) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: SCOPES,
  });

  const res = await fetch(`${AUTHORITY}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const data = await res.json();
  if (data.error) throw new Error(`Token refresh failed: ${data.error} - ${data.error_description}`);
  return data;
}

async function getValidAccessToken() {
  let tokens = loadTokens();
  if (!tokens) throw new Error('No tokens found. Run: node scripts/login.js');

  const now = Math.floor(Date.now() / 1000);
  if (tokens.expires_at && now < tokens.expires_at - 60) {
    return tokens.access_token;
  }

  console.log('Access token expired, refreshing...');
  const newTokens = await refreshAccessToken(tokens.refresh_token);
  tokens = { ...newTokens, expires_at: now + newTokens.expires_in };
  saveTokens(tokens);
  return tokens.access_token;
}

module.exports = { getValidAccessToken };
