const { getPool } = require('../db/init');

const CLIENT_ID = process.env.OAUTH_CLIENT_ID || 'REDACTED_CLIENT_ID';
const CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || 'REDACTED_SECRET';
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:8000/api/auth/callback';
const SCOPES = 'offline_access Files.Read';
const AUTHORITY = 'https://login.microsoftonline.com/consumers';

function getAuthorizationUrl(state) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state,
  });
  return `${AUTHORITY}/oauth2/v2.0/authorize?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
  });
  const res = await fetch(`${AUTHORITY}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Token exchange failed: ${data.error} - ${data.error_description}`);
  return data;
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

async function saveTokensToDb(userId, tokens) {
  const pool = getPool();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = tokens.expires_at || (now + (tokens.expires_in || 3600));
  await pool.query(
    `INSERT INTO user_onedrive_tokens (user_id, access_token, refresh_token, expires_at, scope, token_type, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
     ON CONFLICT (user_id) DO UPDATE SET
       access_token = $2, refresh_token = $3, expires_at = $4, scope = $5, token_type = $6, updated_at = CURRENT_TIMESTAMP`,
    [userId, tokens.access_token, tokens.refresh_token, expiresAt, tokens.scope, tokens.token_type]
  );
}

async function loadTokensFromDb(userId) {
  const pool = getPool();
  const res = await pool.query(
    'SELECT * FROM user_onedrive_tokens WHERE user_id = $1',
    [userId]
  );
  return res.rows[0] || null;
}

async function getValidAccessToken(userId) {
  const tokens = await loadTokensFromDb(userId);
  if (!tokens) throw new Error('No OneDrive tokens for this user. Please connect your OneDrive account.');

  const now = Math.floor(Date.now() / 1000);
  if (tokens.expires_at && now < tokens.expires_at - 60) {
    return tokens.access_token;
  }

  const newTokens = await refreshAccessToken(tokens.refresh_token);
  await saveTokensToDb(userId, newTokens);
  return newTokens.access_token;
}

async function handleOAuthCallback(code, userId) {
  const tokens = await exchangeCodeForTokens(code);
  await saveTokensToDb(userId, tokens);
}

async function hasOneDriveTokens(userId) {
  const tokens = await loadTokensFromDb(userId);
  return tokens !== null;
}

module.exports = { getValidAccessToken, getAuthorizationUrl, handleOAuthCallback, hasOneDriveTokens };
