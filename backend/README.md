# Shared leaderboard

The game stays on GitHub Pages. This small Cloudflare Worker stores the best 100 runs as JSON in one D1 database row and serves the top 10 through `/scores`. The browser submits one result at a time; database access stays inside the Worker. Players do not need accounts or credentials.

The Worker reads the JSON and its revision, merges the new result, and updates only if the revision still matches. First creation inserts only if the row is absent. D1 checks these conditions atomically. A competing write causes a fresh read and merge, with up to five attempts and a short backoff. Queries use D1's primary database, so retries do not read a stale replica. See [D1's database API](https://developers.cloudflare.com/d1/worker-api/d1-database/).

## Cost and abuse limits

Use an account on **Workers Free**. This is the account's Workers subscription, not its website/zone plan. The current free allowances are 100,000 Worker requests per day, 5 million D1 rows read per day, 100,000 rows written per day, and 5 GB total D1 storage. Workers and D1 return errors when their daily free quotas are exhausted; the quotas reset at midnight UTC. Stored scores remain intact. D1 also blocks additional writes when its storage allowance is exhausted. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).

The deployment uses Workers and D1 only and does not need an R2 subscription. **Keep the account on Workers Free to avoid usage overage charges.** Deploying this same code to an account already on Workers Paid, or upgrading later, permits metered charges. The repository cannot enforce your account's billing plan; check it in the dashboard before deploying.

An attacker can exhaust the free quota and temporarily disable shared scores. Other Workers or D1 databases in the same account share these allowances. The game stays playable and uses local scores during an outage. Failed submissions remain local after bounded retries; there is no background queue that uploads them the following day. The per-IP submission rate limit reduces spam but is not the spending protection: the provider's Workers Free quotas provide that boundary.

## Deploy

Sign in to Cloudflare and confirm the selected account has the **Workers Free** subscription. A free Cloudflare website plan alone does not confirm this. No R2 setup is needed. The [D1 getting-started guide](https://developers.cloudflare.com/d1/get-started/) covers the database and Worker setup.

The commands below use Wrangler **4.149.0**, the version used to validate this configuration. Run them from `backend/` with Node.js installed:

```sh
npx --yes wrangler@4.149.0 login
npx --yes wrangler@4.149.0 whoami
```

The configuration already points to the existing `space-invaders` database through `LEADERBOARD_DB`; log in to the account that owns it. If your login has multiple Cloudflare accounts, set the intended `account_id` in `wrangler.jsonc`. The database ID is not a secret. If rate-limit namespace `16216001` is already in use in that account, choose another positive integer for `namespace_id`.

For a separate installation in another account, create your own database with `npx --yes wrangler@4.149.0 d1 create space-invaders --binding LEADERBOARD_DB`. That command updates the matching binding in `wrangler.jsonc`. Alternatively, use the ID of a database you already created in that account.

Initialize the remote database, then deploy:

```sh
npx --yes wrangler@4.149.0 d1 execute space-invaders --remote --file=./schema.sql
npx --yes wrangler@4.149.0 deploy
```

The schema creates the table without deleting existing scores. The Worker accesses it through its `LEADERBOARD_DB` binding; there is no public database URL to configure.

Wrangler prints the deployed URL, such as `https://space-invaders-leaderboard.YOUR-SUBDOMAIN.workers.dev`. Set that base URL in the game's [leaderboard-config.js](../leaderboard-config.js), without `/scores`:

```js
window.SPACE_INVADERS_LEADERBOARD_URL = 'https://space-invaders-leaderboard.YOUR-SUBDOMAIN.workers.dev';
```

Publish the updated game files to GitHub Pages. A blank URL keeps the game in local-only leaderboard mode. The API URL is public configuration, not a secret. For a different game host, change `ALLOWED_ORIGIN` in `wrangler.jsonc` to its exact origin (scheme and host, no path or trailing slash), then redeploy the Worker.

Check the deployed `/scores` URL: it should initially return `{"scores":[]}`. Finish a game in one browser, submit a score, and open the game in another browser to verify sharing. The game also keeps local scores when the network is unavailable.

## Local testing

From the repository root, the dependency-free tests run on Node.js 24 or later with:

```sh
node --test
```

The backend tests run the real schema and queries against SQLite. They cover competing initial creations, competing updates, request retries, invalid input, CORS, rate limits, quota/storage failures, and corrupted state. If your sandbox blocks Node's test subprocess reporting, use `node --test --test-isolation=none tests/leaderboard-worker.test.mjs` on Node 24.

To validate the deployment bundle without publishing anything, run from `backend/`:

```sh
npx --yes wrangler@4.149.0 deploy --dry-run --outdir /tmp/space-invaders-worker-build
```

To initialize and run the Worker against local emulated D1 storage, without creating a Cloudflare database or logging in:

```sh
npx --yes wrangler@4.149.0 d1 execute space-invaders --local --file=./schema.sql
npx --yes wrangler@4.149.0 dev --local --port 8787 --var ALLOWED_ORIGIN:http://localhost:8000
```

Serve the repository in another terminal with `python3 -m http.server 8000`, temporarily set `SPACE_INVADERS_LEADERBOARD_URL` to `http://localhost:8787`, and open `http://localhost:8000`. Restore the production URL or blank configuration before publishing. Local D1 files live under the ignored `backend/.wrangler/` directory and do not modify production scores. Local tests exercise the configured rate-limit binding; a missing binding returns an error instead of silently disabling it.

## API and limits

`GET /scores` returns `{"scores":[...]}`, ordered by score descending, then level descending, then earliest server timestamp and ID. Each result has `id`, `name`, `score`, `level`, and an ISO `date`. Reads require no login; browser CORS is enabled only for `ALLOWED_ORIGIN`.

`POST /scores` accepts `Content-Type: application/json` and exactly these fields:

```json
{
  "id": "00000000-0000-4000-8000-000000000001",
  "name": "Pilot",
  "score": 1450,
  "level": 4
}
```

Names are trimmed and limited to 12 characters; scores must be integers from 0 to 100000; levels must be integers from 1 to 6. Requests are limited to 8 KiB. The Worker assigns the timestamp. The browser must reuse the same UUID and payload when retrying a submission. A duplicate retained ID returns the existing board without writing; a different payload using that ID returns `409`. Only the best 100 runs are retained, so IDs belonging to evicted runs are no longer remembered.

Successful submissions return the current top 10. Errors return `{"error":"..."}`. `429` and temporary `503` responses include `Retry-After`; a busy board gets five merge attempts before a `503`. Malformed existing state or an exhausted D1 quota returns `503`; the Worker preserves existing data. If the Workers request quota is exhausted, Cloudflare rejects requests before our code runs and the client falls back to local scores.

The configured rate-limit binding allows approximately 10 submissions per minute per Cloudflare-provided IP address per Cloudflare location. Players sharing an IP share that allowance; IP addresses are not written into the leaderboard. Cloudflare's limiter is approximate and local to each location, so it is an abuse deterrent rather than a global hard quota. See [rate-limit bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

Scores and names are public and self-reported. CORS, validation, and rate limiting reduce accidental misuse and basic spam; they do not prove a score was earned. Someone can spoof the request origin and submit a plausible invented score. Embedding a signing key in browser JavaScript would not fix that. Stronger verification would require a server-validated game or replay system.
