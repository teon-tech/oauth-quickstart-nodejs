# Node.js OAuth 2.0 Quickstart

A quickstart app for integrators looking to use HubSpot's OAuth 2.0. Written in Node.js.

_**Note:** This app does not store any data in a persistent way, so restarting the app will clear the retrieved access tokens._

## What the app does

1. **Redirect to HubSpot's OAuth 2.0 server**

   When you open your browser to `http://localhost:3000/install`, the app will redirect you to the authorization page on
   HubSpot's server. Here you will choose which account you'd like to install the app in and give consent for it to act
   on your behalf. When this is complete, HubSpot will redirect you back to the app.

   `client_id`, `client_secret`, and `scope` can be provided either as query params on `/install` (useful for
   installing multiple different HubSpot apps from the same running server) or as environment variables, which
   are used as the default whenever a query param isn't supplied:
   ```
   http://localhost:3000/install?client_id=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx&client_secret=yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy&scope=crm.objects.contacts.read
   ```
   **Security note:** sending `client_secret` as a query param on a `GET` request can expose it in browser
   history, server access logs, and the `Referer` header. That's an acceptable trade-off for this local
   quickstart, but avoid this pattern in a production app — prefer sending sensitive values in a request body,
   the same way the token exchange in step 2 already does.

2. **Exchange an authorization code for access tokens**

   Now that you're back in the app, it will retrieve an access token and a refresh token from HubSpot's server, using an
   The authorization code is provided by HubSpot when you grant the app access.
   
   **Note**: The [v3 OAuth API](https://developers.hubspot.com/docs/api-reference/auth-oauth-v3/guide) requires 
that parameters (`client_id`, `client_secret`, `code`, etc.) are sent in the request body 
as form URL-encoded data rather than as query parameters. The OAuth v3 endpoints provide enhanced security by ensuring sensitive data like your app's client ID and secret are sent in the 
request body rather than as URL parameters, preventing them from appearing in 
server logs.

4. **Confirm the install**

   When the app has received an access token, it will redirect you to `http://localhost:3000/`, which shows
   whether the app is installed for the current session ("Status: app installed" / "Status: app not
   installed"). It does not make any further calls to HubSpot's API — `getContact` in `index.js` is left in
   as an example of how to make an authenticated API call using the stored access token, if you want to add
   that back.
   
## Prerequisites

Before running the quickstart app, make sure you have:

1. The tools required to run using the method of your choice:
   - Option 1: Running locally using Node.js: [Node.js (>=6)](https://nodejs.org) and [yarn](https://yarnpkg.com/en/docs/install)
   - Option 2: Running in a Docker container: [Docker (>=1.13)](https://docs.docker.com/install/)
2. A HubSpot account ([sign up](https://developers.hubspot.com/docs/getting-started/account-types))
3. An app associated with your developer account on the latest developer platform version ([create an app](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/create-an-app))
4. A HubSpot account to install the app in (you can use an existing one, or [create a test account](https://developers.hubspot.com/docs/getting-started/account-types#developer-test-accounts))

_**Note:** You must be a super-admin for the account that you want to install the app in._

## Option 1: Running locally using Node.js

1. Clone the repository:
   ```bash
   $ git clone git@github.com:HubSpot/oauth-quickstart-nodejs.git
   ```
2. Create a **`.env`** file in the root of the repository with the ID and secret for your app (found on the app settings page), eg:
   ```
   CLIENT_ID='xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
   CLIENT_SECRET='yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy'
   SCOPE='crm.objects.contacts.read,forms'
   ```
   `CLIENT_ID`, `CLIENT_SECRET`, and `SCOPE` in the `.env` file are all optional — they're only used as
   defaults for whichever of `client_id`, `client_secret`, or `scope` aren't passed as query params on
   `/install` (see step 1 above). If neither is provided, `SCOPE` defaults to `crm.objects.contacts.read`.
   The scopes can be separated by a comma, space, or URL-encoded space (`%20`)

   By default the app builds its OAuth redirect URI as `http://localhost:3000/oauth-callback`. If you're
   deploying this app somewhere with a real domain rather than running it locally, set `BASE_URL` to your
   app's public URL, eg:
   ```
   BASE_URL='https://your-app.example.com'
   ```
   The app will then use `https://your-app.example.com/oauth-callback` as its redirect URI. This must exactly
   match a redirect URI configured in your HubSpot app's auth settings, or HubSpot will reject the
   authorization request.
3. From the root of the repository, run:
   ```bash
   $ yarn install
   $ yarn start
   ```
4. Open your browser to `http://localhost:3000/install` to kick off the OAuth 2.0 flow

---

## Option 2: Running in a Docker container

1. Build an image of the quickstart app

```
$ docker build -t hs-oauth-quickstart:latest git://github.com/HubSpot/oauth-quickstart-nodejs.git
```

2. Run a container with the new image

```
$ docker run --init -it -p 3000:3000 -e CLIENT_SECRET=$CLIENT_SECRET -e CLIENT_ID=$CLIENT_ID -e SCOPE=contacts,forms hs-oauth-quickstart:latest
```

---

## Option 3: Deploying to Vercel

The app is exported as a serverless function (`module.exports = app` in `index.js`) and routed via
`vercel.json`, so it can be deployed directly with the [Vercel CLI](https://vercel.com/docs/cli):

1. Install the CLI and log in (skip if already set up):
   ```bash
   $ npm i -g vercel
   $ vercel login
   ```
2. From the root of the repository, deploy:
   ```bash
   $ vercel deploy --prod
   ```
3. In the Vercel project's dashboard, under **Settings → Environment Variables**, set:
   - `CLIENT_ID`, `CLIENT_SECRET`, `SCOPE` — same as the `.env` values described above (optional; can also be
     passed as `/install` query params instead).
   - `BASE_URL` — the deployment's public URL, eg. `https://your-project.vercel.app` (see `.env.example`).
   - `SESSION_SECRET` — any random string, so the session cookie's signing secret is stable across
     invocations of the same warm serverless instance.
   
   Redeploy after setting these so they take effect.
4. In your HubSpot app's auth settings, add `https://your-project.vercel.app/oauth-callback` as a valid
   redirect URI (must exactly match `BASE_URL` + `/oauth-callback`).

**Important caveat:** `refreshTokenStore`, `accessTokenCache`, and the session store are all kept in the
serverless function's in-memory process, not in an external store. Vercel does not guarantee that the
`/install` → `/oauth-callback` round trip (or later visits to `/`) land on the same warm instance, so this
setup is only reliable for light, infrequent use where a warm instance is likely to be reused — under heavier
or concurrent traffic you may intermittently see "No pending installation found for this session" or lose
cached tokens across requests. If that starts happening, move session/token storage to an external store
(eg. Vercel KV / Upstash Redis).
