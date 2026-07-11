# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

HubSpot's Node.js OAuth 2.0 quickstart app — a minimal reference implementation showing integrators how to
implement the OAuth 2.0 authorization-code flow against HubSpot's API and use the resulting access token to
call the Contacts API. The entire app is a single file: `index.js`.

## Commands

- Install dependencies: `yarn install`
- Run the app: `yarn start` (runs `node index.js`, listens on port 3000, opens the browser automatically)
- Docker build: `docker build -t hs-oauth-quickstart:latest .`
- Docker run: `docker run --init -it -p 3000:3000 -e CLIENT_SECRET=$CLIENT_SECRET -e CLIENT_ID=$CLIENT_ID -e SCOPE=contacts,forms hs-oauth-quickstart:latest`

There are no tests, lint, or build scripts in this project.

### CLIENT_ID / CLIENT_SECRET / SCOPE / BASE_URL

`CLIENT_ID`, `CLIENT_SECRET`, and `SCOPE` env vars are all optional. They act as the default whenever the
corresponding `client_id`, `client_secret`, or `scope` query param isn't passed to `/install` — see
Architecture below. `SCOPE` accepts comma-, space-, or `%20`-separated scopes and defaults to
`crm.objects.contacts.read` if not set anywhere. These are normally supplied via a `.env` file (loaded with
`dotenv`) or as Docker env vars.

`BASE_URL` controls the public origin used to build the OAuth redirect URI (`${BASE_URL}/oauth-callback`,
`index.js:37-41`). Defaults to `http://localhost:${PORT}`. Must be set to the app's real public URL when
deployed anywhere other than localhost, and must exactly match a redirect URI configured in the HubSpot app's
auth settings.

## Architecture

Everything lives in `index.js` as a single Express app, structured around the OAuth flow steps (the file's
section comments follow this same order):

1. **`resolveOAuthParams(req)`** — resolves `clientId`/`clientSecret`/`scopes` for a request, preferring
   `req.query.client_id`/`client_secret`/`scope` and falling back to the `CLIENT_ID`/`CLIENT_SECRET`/`SCOPE`
   env vars. This lets the same running server be used to install multiple different HubSpot apps.
2. **`/install`** — resolves params via `resolveOAuthParams`, redirects to `/error` if `clientId`/
   `clientSecret` are missing from both query and env, otherwise stores `{ clientId, clientSecret }` in
   `req.session.oauth` (needed later since HubSpot's callback doesn't include the client secret) and
   redirects to HubSpot's authorization URL built from those values.
3. **`/oauth-callback`** — receives the `code` query param from HubSpot, reads `clientId`/`clientSecret` back
   out of `req.session.oauth` (redirects to `/error` if no session state exists), and calls
   `exchangeForTokens` to trade the code for an access/refresh token pair.
4. **`exchangeForTokens`** — POSTs to `https://api.hubapi.com/oauth/v3/token` (form-encoded body, per the
   OAuth v3 API) and stores the results in two in-memory stores keyed by Express session ID
   (`req.sessionID`):
   - `refreshTokenStore` (plain object) — `{ refreshToken, clientId, clientSecret }` per session, kept
     indefinitely for the process lifetime. The `clientId`/`clientSecret` are carried along so a later
     refresh uses the correct app's credentials, since different sessions may belong to different apps.
   - `accessTokenCache` (`node-cache`) — access tokens, expired automatically at 75% of the token's
     `expires_in`.
5. **`getAccessToken`** / **`refreshAccessToken`** — transparently refresh an expired access token using the
   `clientId`/`clientSecret`/`refreshToken` stored in `refreshTokenStore` for that session.
6. **`getContact`** — example authenticated API call, fetching one contact from the Contacts API using the
   access token as a Bearer token. This is the intended extension point for testing other HubSpot API calls
   (see the comment above the `request.get` call).
7. **`/`** — if the current session is authorized, fetches and displays a contact; otherwise shows an
   "Install the app" link.

There is no database and no persistent storage — all tokens live in process memory, so restarting the server
clears every user's authorization state. This is intentional (per the README) since the app is a teaching
example, not a production template.

**Security note:** `/install` accepts `client_secret` as a query param, which can leak into browser history,
server access logs, or the `Referer` header on a `GET` request. That's a deliberate, documented trade-off for
this local quickstart (see README) — don't treat it as a pattern to replicate in production code.
