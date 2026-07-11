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

// Use a session to keep track of client ID
app.use(session({
  secret: Math.random().toString(36).substring(2),
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

// Step 2
// The user is prompted to give the app access to the requested
// resources. This is all done by HubSpot, so no work is necessary
// on the app's end

// Step 3
// Receive the authorization code from the OAuth 2.0 Server,
// and process it based on the query parameters that are passed
app.get('/oauth-callback', async (req, res) => {
  console.log('===> Step 3: Handling the request sent by the server');

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
    res.redirect(`/`);
  }
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

app.get('/', async (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.write(`<h2>HubSpot OAuth 2.0 Quickstart App</h2>`);
  if (isAuthorized(req.sessionID)) {
    const accessToken = await getAccessToken(req.sessionID);
    const contact = await getContact(accessToken);
    res.write(`<h4>Access token: ${accessToken}</h4>`);
    displayContactName(res, contact);
  } else {
    res.write(`<a href="/install"><h3>Install the app</h3></a>`);
  }
  res.end();
});

app.get('/error', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.write(`<h4>Error: ${req.query.msg}</h4>`);
  res.end();
});

app.listen(PORT, () => console.log(`=== Starting your app on http://localhost:${PORT} ===`));
opn(`http://localhost:${PORT}`);
