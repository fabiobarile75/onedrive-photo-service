const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const open = require('open');

const CLIENT_ID = process.env.OAUTH_CLIENT_ID || 'REDACTED_CLIENT_ID';
const CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || 'REDACTED_SECRET';
const REDIRECT_URI = 'http://localhost:3333/callback';
const SCOPES = 'offline_access Files.Read';
const TOKEN_FILE = path.join(__dirname, '../tokens.json');
const AUTHORITY = 'https://login.microsoftonline.com/consumers';

function saveTokens(tokens) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
  console.log('✓ Tokens saved to tokens.json');
}

async function startLoginFlow() {
  const app = express();

  const authUrl = `${AUTHORITY}/oauth2/v2.0/authorize?` + new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    response_mode: 'query',
  });

  console.log('\n🔐 Opening browser for authentication...\n');

  return new Promise((resolve, reject) => {
    const server = app.listen(3333, async () => {
      console.log('✓ Server listening on http://localhost:3333');
      console.log('✓ Opening browser...\n');

      try {
        await open(authUrl);
      } catch (err) {
        console.log('\n📋 Please open this URL in your browser:\n');
        console.log(authUrl);
        console.log('\n');
      }
    });

    app.get('/callback', async (req, res) => {
      const code = req.query.code;

      if (!code) {
        const msg = `Error: no authorization code received. Params: ${JSON.stringify(req.query)}`;
        res.send(`<h2 style="color: red;">${msg}</h2>`);
        server.close();
        reject(new Error(msg));
        return;
      }

      try {
        const params = new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          scope: SCOPES,
        });

        console.log('🔄 Exchanging authorization code for tokens...');

        const tokenRes = await fetch(`${AUTHORITY}/oauth2/v2.0/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
        });

        const tokens = await tokenRes.json();

        if (tokens.error) {
          throw new Error(`${tokens.error}: ${tokens.error_description}`);
        }

        const now = Math.floor(Date.now() / 1000);
        saveTokens({ ...tokens, expires_at: now + tokens.expires_in });

        res.send(`
          <html>
            <head>
              <style>
                body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 40px; text-align: center; }
                h2 { color: #388e3c; }
                p { color: #666; }
              </style>
            </head>
            <body>
              <h2>✓ Authentication Successful!</h2>
              <p>Your tokens have been saved. You can close this window.</p>
            </body>
          </html>
        `);

        console.log('✓ Authentication successful!\n');
        server.close();
        resolve();
      } catch (err) {
        res.send(`<h2 style="color: red;">Error: ${err.message}</h2>`);
        server.close();
        reject(err);
      }
    });
  });
}

async function main() {
  try {
    await startLoginFlow();
    console.log('✓ You can now start the service\n');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Authentication failed:', err.message);
    process.exit(1);
  }
}

main();
