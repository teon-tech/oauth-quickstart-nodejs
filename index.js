require('dotenv').config();
const express = require('express');
const request = require('request-promise-native');
const NodeCache = require('node-cache');
const session = require('express-session');
const opn = require('open');
const app = express();

const PORT = 3000;

const refreshTokenStore = {};
const accessTokenCache = new NodeCache({ deleteOnExpire: true });

//===========================================================================//
//  HUBSPOT APP CONFIGURATION
//
//  client_id, client_secret, and scope can be provided per request as query
//  params on /install (to support installing multiple different apps from
//  this same server), or as environment variables, which are used as the
//  default whenever a query param is not supplied.
//===========================================================================//

const normalizeScopes = (scope) => (scope.split(/ |, ?|%20/)).join(' ');

// Resolves client_id, client_secret, and scope for a request, preferring
// query params and falling back to the CLIENT_ID/CLIENT_SECRET/SCOPE
// environment variables.
const resolveOAuthParams = (req) => {
    const clientId = req.query.client_id || process.env.CLIENT_ID;
    const clientSecret = req.query.client_secret || process.env.CLIENT_SECRET;
    const rawScope = req.query.scope || process.env.SCOPE || 'crm.objects.contacts.read';
    const scopes = normalizeScopes(rawScope);
    return { clientId, clientSecret, scopes };
};

// On successful install, users will be redirected to /oauth-callback.
// BASE_URL should be set to your public URL (eg. https://your-app.example.com)
// when deploying somewhere other than localhost; it must exactly match a
// redirect URI configured in your HubSpot app's auth settings.
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const REDIRECT_URI = `${BASE_URL}/oauth-callback`;

//===========================================================================//

// Use a session to keep track of client ID.
// SESSION_SECRET can be set explicitly (recommended on Vercel) so the signing
// secret stays stable instead of being randomized on every cold start.
app.use(session({
  secret: process.env.SESSION_SECRET || Math.random().toString(36).substring(2),
  resave: false,
  saveUninitialized: true
}));
 
//================================//
//   Running the OAuth 2.0 Flow   //
//================================//

// Step 1
// Build the authorization URL to redirect a user to when they choose to
// install the app, and remember which client_id/client_secret this
// installation is for so /oauth-callback can complete the exchange (HubSpot
// does not send the client_secret back on the callback).
app.get('/install', (req, res) => {
  console.log('');
  console.log('=== Initiating OAuth 2.0 flow with HubSpot ===');
  console.log('');

  const { clientId, clientSecret, scopes } = resolveOAuthParams(req);
  if (!clientId || !clientSecret) {
    return res.redirect('/error?msg=Missing client_id or client_secret (pass as query params or set CLIENT_ID/CLIENT_SECRET env vars)');
  }

  // Start a brand new session for this install attempt so it can never
  // inherit the "installed" status left over from a previous install in this
  // same browser (eg. testing a second app, or retrying after canceling
  // consent on HubSpot's page).
  req.session.regenerate((err) => {
    if (err) {
      return res.redirect('/error?msg=Could not start a new session for this install attempt');
    }

    req.session.oauth = { clientId, clientSecret };

    const authUrl =
      'https://app.hubspot.com/oauth/authorize' +
      `?client_id=${encodeURIComponent(clientId)}` + // app's client ID
      `&scope=${encodeURIComponent(scopes)}` + // scopes being requested by the app
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`; // where to send the user after the consent page

    console.log("===> Step 1: Redirecting user to your app's OAuth URL");
    res.redirect(authUrl);
    console.log('===> Step 2: User is being prompted for consent by HubSpot');
  });
});

// Step 2
// The user is prompted to give the app access to the requested
// resources. This is all done by HubSpot, so no work is necessary
// on the app's end

// Step 3
// Receive the authorization code from the OAuth 2.0 Server,
// and process it based on the query parameters that are passed
app.get('/oauth-callback', async (req, res) => {
  console.log('===> Step 3: Handling the request sent by the server');

  // HubSpot redirects here with ?error=... (eg. the app's configured scopes
  // or redirect_uri don't match what was requested) instead of ?code=... when
  // it can't proceed with the install — sometimes before the user even gets
  // to click "Connect app". Handle that explicitly instead of hanging.
  if (req.query.error) {
    console.error(`       > HubSpot returned an OAuth error: ${req.query.error} - ${req.query.error_description || ''}`);
    return res.redirect(`/error?msg=${encodeURIComponent(req.query.error_description || req.query.error)}`);
  }

  // Received a user authorization code, so now combine that with the other
  // required values and exchange both for an access token and a refresh token
  if (req.query.code) {
    console.log('       > Received an authorization token');

    const oauthSession = req.session.oauth;
    if (!oauthSession) {
      return res.redirect('/error?msg=No pending installation found for this session. Start at /install.');
    }

    const authCodeProof = {
      grant_type: 'authorization_code',
      client_id: oauthSession.clientId,
      client_secret: oauthSession.clientSecret,
      redirect_uri: REDIRECT_URI,
      code: req.query.code
    };

    // Step 4
    // Exchange the authorization code for an access token and refresh token
    console.log('===> Step 4: Exchanging authorization code for an access token and refresh token');
    const token = await exchangeForTokens(req.sessionID, authCodeProof);
    if (token.message) {
      return res.redirect(`/error?msg=${token.message}`);
    }

    // Once the tokens have been retrieved, use them to make a query
    // to the HubSpot API
    return res.redirect(`/`);
  }

  res.redirect('/error?msg=' + encodeURIComponent('HubSpot did not send an authorization code or error.'));
});

//==========================================//
//   Exchanging Proof for an Access Token   //
//==========================================//

const exchangeForTokens = async (userId, exchangeProof) => {
  try {
    const responseBody = await request.post('https://api.hubapi.com/oauth/v3/token', {
      form: exchangeProof
    });
    // Usually, this token data should be persisted in a database and associated with
    // a user identity.
    const tokens = JSON.parse(responseBody);
    // Keep the client_id/client_secret alongside the refresh token so a later
    // refresh (see refreshAccessToken) uses the credentials of the app this
    // session was installed with, since multiple apps can be installed from
    // this same server.
    refreshTokenStore[userId] = {
      refreshToken: tokens.refresh_token,
      clientId: exchangeProof.client_id,
      clientSecret: exchangeProof.client_secret
    };
    accessTokenCache.set(userId, tokens.access_token, Math.round(tokens.expires_in * 0.75));

    console.log('       > Received an access token and refresh token');
    return tokens.access_token;
  } catch (e) {
    console.error(`       > Error exchanging ${exchangeProof.grant_type} for access token`);
    return JSON.parse(e.response.body);
  }
};

const refreshAccessToken = async (userId) => {
  const { clientId, clientSecret, refreshToken } = refreshTokenStore[userId];
  const refreshTokenProof = {
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
    refresh_token: refreshToken
  };
  return await exchangeForTokens(userId, refreshTokenProof);
};

const getAccessToken = async (userId) => {
  // If the access token has expired, retrieve
  // a new one using the refresh token
  if (!accessTokenCache.get(userId)) {
    console.log('Refreshing expired access token');
    await refreshAccessToken(userId);
  }
  return accessTokenCache.get(userId);
};

const isAuthorized = (userId) => {
  return refreshTokenStore[userId] ? true : false;
};

//====================================================//
//   Using an Access Token to Query the HubSpot API   //
//====================================================//

const getContact = async (accessToken) => {
  console.log('');
  console.log('=== Retrieving a contact from HubSpot using the access token ===');
  try {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    };
    console.log('===> Replace the following request.get() to test other API calls');
    console.log('===> request.get(\'https://api.hubapi.com/contacts/v1/lists/all/contacts/all?count=1\')');
    const result = await request.get('https://api.hubapi.com/contacts/v1/lists/all/contacts/all?count=1', {
      headers: headers
    });

    return JSON.parse(result).contacts[0];
  } catch (e) {
    console.error('  > Unable to retrieve contact');
    return JSON.parse(e.response.body);
  }
};

//========================================//
//   Displaying information to the user   //
//========================================//

const displayContactName = (res, contact) => {
  if (contact.status === 'error') {
    res.write(`<p>Unable to retrieve contact! Error Message: ${contact.message}</p>`);
    return;
  }
  const { firstname, lastname } = contact.properties;
  res.write(`<p>Contact name: ${firstname.value} ${lastname.value}</p>`);
};

const escapeHtml = (str) => String(str).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.write(`<h2>HubSpot OAuth 2.0 Quickstart App</h2>`);
  if (isAuthorized(req.sessionID)) {
    const installedClientId = refreshTokenStore[req.sessionID].clientId;
    res.write(`<h3>Status: app installed</h3><p></p>`);
  } else {
    res.write(`
      <h3>Status: app not installed</h3>
      <h3>Generate an install link</h3>
      <p><small>Fill these in and generate a link to send to your client — they just need to click it, they
      won't see this form.</small></p>
      <form id="install-form">
        <div>
          <label for="client_id">Client ID</label><br/>
          <input type="text" id="client_id" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" size="50" />
        </div>
        <div>
          <label for="client_secret">Client Secret</label><br/>
          <input type="password" id="client_secret" placeholder="yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy" size="50" />
        </div>
        <div>
          <label for="scope">Scope</label><br/>
          <input type="text" id="scope" placeholder="crm.objects.contacts.read" size="50" />
        </div>
        <br/>
        <button type="submit">Generate install link</button>
      </form>
      <p><small>Leave a field blank to fall back to its CLIENT_ID/CLIENT_SECRET/SCOPE environment variable.</small></p>
      <div id="install-url-wrapper" style="display:none">
        <label for="install-url">Send this link to your client:</label><br/>
        <input type="text" id="install-url" size="80" readonly onclick="this.select()" />
      </div>
      <script>
        document.getElementById('install-form').addEventListener('submit', function (e) {
          e.preventDefault();
          var params = new URLSearchParams();
          ['client_id', 'client_secret', 'scope'].forEach(function (field) {
            var value = document.getElementById(field).value.trim();
            if (value) params.set(field, value);
          });
          var query = params.toString();
          var url = window.location.origin + '/install' + (query ? ('?' + query) : '');
          var input = document.getElementById('install-url');
          input.value = url;
          document.getElementById('install-url-wrapper').style.display = 'block';
          input.select();
        });
      </script>
    `);
  }
  res.end();
});

app.get('/error', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.write(`<h4>Error: ${req.query.msg}</h4>`);
  res.end();
});

// On Vercel, the app is imported as a serverless function handler (see
// module.exports below) instead of listening on a port itself.
if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`=== Starting your app on http://localhost:${PORT} ===`));
  opn(`http://localhost:${PORT}`);
}

module.exports = app;
