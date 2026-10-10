# space_invaders

Space Invaders in the browser: 6 levels, alien formations, and destructible bunkers.

The first version was built with **GLM-5.2**. Subsequent versions and improvements were developed with **Codex Astra**.

| Level | Formation | Waves |
| --- | --- | --- |
| 1 — Grid Assault | Classic rows | 1 |
| 2 — Diamond Wing | Diamond | 2 |
| 3 — Chaos Swarm | Split V | 2 |
| 4 — Twin Wings | Two attack wings | 2 |
| 5 — Orbital Ring | Ring around a central alien | 2 |
| 6 — Final Fortress | Fortified fleet | 2 |

Later levels move faster, fire more often, and launch dives sooner. Complete all 11 waves to win.

Diving aliens leave an empty slot in the moving formation, fly toward the player, and return from above to rejoin their slot if they miss. Only a collision with an alien or its bullets costs a life; an alien leaving the screen does not.

Includes retro sound effects and an original looping 8-bit soundtrack that speeds up with each level. Audio begins after pressing **START**. Toggle **SFX** and **MUSIC** independently, or press **M** to mute/unmute both; preferences are remembered. Audio pauses when the tab is hidden.

All sounds are synthesized in the browser with the Web Audio API—no audio files, external libraries, or downloads are required. Open `index.html` to play locally.

On phones, **Left / Right** are grouped on the left and **Fire** is on the right. Hold Fire with one thumb while steering with the other.

The optional shared leaderboard uses Cloudflare Workers and D1 on the **Workers Free plan**. D1 stores a small JSON board with atomic revision checks and retries to preserve simultaneous submissions; submission IDs prevent duplicates when a response is lost. Player names and scores are public; no player accounts or browser credentials are needed. See [backend setup and deployment](backend/README.md).

Score submissions carry an HMAC-SHA256 signature that the Worker verifies before accessing D1. The shared key is lightly obfuscated in the browser code to discourage casual tampering. It is extractable, so this does not prove a score was earned or prevent a determined player from forging one. Stored scores remain readable JSON.

On Workers Free, exhausting the Workers or D1 daily quota makes requests fail until the daily reset instead of creating usage overage charges. An attacker can temporarily exhaust the shared quota, so the game falls back to local scores. This depends on keeping the account's **Workers subscription Free**; Workers Paid allows usage charges. See [D1 pricing and free limits](https://developers.cloudflare.com/d1/platform/pricing/) and [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

The deployed service URL is configured in [leaderboard-config.js](leaderboard-config.js). Set it to an empty string to use local scores only. If the service is unavailable, the game remains playable and shows local scores. Failed submissions remain local after bounded retries.

Run regression checks with `node --test` on Node.js 24 or later (no dependencies). They cover all levels and waves, collisions, touch/keyboard controls, local score storage, online requests, and concurrent leaderboard updates against SQLite.

**Play it:** https://pavelzak.github.io/space_invaders/
