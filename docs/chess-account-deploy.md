# Chess account service deployment

The reviewed SQL migration is already applied. Do not apply it again. The Worker now serving production is still the `1925b2a8` module. This branch changes that module. It is not deployed. A later deploy replaces only the module and keeps the same Worker name, route, Hyperdrive binding, and secrets.

## Already applied

- Migration `supabase/chess_release.sql` from `1925b2a8e191dea47b16f6a46cd0aa8caf47d3d9` is applied as Supabase migration version `20261108174719`. Its SHA256 is `2607b715ed5c8c18930748891b0187237a6a7d06ee2ba9200f43b20c8e0e2d7c`. Leave that version in place.
- The Worker now serving production is `chess-api` from that same commit. Its module SHA256 is `9d460b57856c0e5ef8fb1d5b6aa6ce1b3554a37ed7e68c344f6b45da0d298079`. Compatibility date `2026-11-08`. Flag `nodejs_compat`. This branch builds a different module. Deploying it keeps the Hyperdrive id, route, and secrets below. Do not publish `wrangler.jsonc` while its Hyperdrive id is still the placeholder.
- Hyperdrive `fc681330ac0540309ebf509fdd3f3fa8` is direct, uses role `chess_server`, has caching disabled, and has a maximum of 5 connections. `chess_authority` stays `NOLOGIN` and is not on the Worker or Hyperdrive.
- Data API exposed schemas are `public` and `graphql_public` only. Keep `chess_private` and `chess_service` unexposed.
- The Compass Site URL is unchanged. `https://chess.theworldgovernmentincorporated.com/api/auth/callback` is allowed.
- The route is only `chess.theworldgovernmentincorporated.com/api/*`. The existing CNAME is proxied and GitHub Pages still serves the rest of the site. `workers.dev` and preview URLs are disabled. Query-string log redaction is enabled.
- The account subdomain `theworldgovernmentincorporated.workers.dev` is registered. The cron `*/15 * * * *` was created at 2:12:23 PM EST on 8 November 2026. A later invocation was observed with outcome ok, from bounded metadata.
- Anonymous `GET /api/session` and `GET /api/posts` returned 200 with `no-store`. The site root returned 200.
- On 8 November 2026, a normal-browser sign-in on the published page reached “Signed in. No Chess profile yet.” at 2:26 PM EST. Sign out and a refresh showed “Not signed in.” at 2:28 PM EST. The live cookie flags were not inspected separately. No join, post, private row, or real game save has been tested.

`wrangler.jsonc` in the repository still contains `REPLACE_WITH_CACHE_DISABLED_HYPERDRIVE_ID`. That placeholder is not the live binding. Do not deploy the repository config over the Worker that is already running.

`GET /api/auth/start` returns 405. Sign-in is a POST.

On 8 November 2026 at 3:03 PM EST, an emailed link left Community signed out, and the page showed “The request could not be completed.” From 2:55 to 3:05:30 PM the Worker metadata listed six `GET /api/session` responses at 200, one `POST /api/auth/start` at 200, one `POST /api/auth/start` at 400, two `GET /api/auth/callback` responses at 303, and one callback the client canceled. No 5xx was listed. Response bodies, cookies, and private logs were not read, so those counts do not establish why the browser stayed signed out. The public settings response listed Google and email as enabled. That does not prove the Google client credentials or consent screen.

## Google sign-in

Continue with Google uses the same opaque Chess session as the email link. Chess asks GoTrue `GET /auth/v1/authorize` and reads only its 302 `Location`. It does not follow that redirect. The browser then goes to Google, Google returns to `https://xfswvbxuhgqbdqpqiywa.supabase.co/auth/v1/callback`, and Supabase returns to `https://chess.theworldgovernmentincorporated.com/api/auth/callback` with a one-time code. Chess exchanges that code on the server. The page does not receive a master token. Joining Chess is still a separate button. `access_denied` is shown as a provider refusal, not as proof the person canceled.

This module is not the one serving production. The parent deploys it before Continue with Google or the callback notices work. Do not apply `supabase/chess_release.sql` again. Keep Hyperdrive `fc681330ac0540309ebf509fdd3f3fa8`, the `/api/*` route, and the existing Worker secrets. In Google Cloud, the authorized redirect URI remains `https://xfswvbxuhgqbdqpqiywa.supabase.co/auth/v1/callback`. The Chess callback is already on the Supabase allowlist. The Google client id and secret stay in Supabase. `SUPABASE_ANON_KEY` is not placed on the Google URL.

## Next candidate

Publishing the site without the new Worker leaves Continue with Google and the callback notices on the old module. SQL bytes stay the applied `1925b2a8` migration. The Worker module in this branch is new and is deployed separately, with the same bindings, route, and secrets.

Local and CI checks of join and save used a stand-in identity service and a throwaway database. They are not production results. The first production join and the first production saved game happen only if this candidate is published and then used.

1. On `/community/`, enter the email and a display name, then click Email me a sign-in link. Open the link. The page asks for Join Chess and does not create the profile until that button is used. Click Join Chess and confirm the signed-in display name. This production join is not yet verified.
2. Open Bot chess. The existing piece sets, colors, and bot limits remain. Finish a game and click Save to account. Reload and confirm the game is listed. Open Replay and use Previous move on the separate board.
3. Discard one finished game before saving it, and confirm it is absent after reload. Turn on automatic saving, finish another game, and confirm it is stored once. A game started on one profile must not be saved after switching to another profile.

## Behavior the service implements

- The browser gets an opaque `__Host-chess_session` cookie. It never receives the master JWT.
- Joining Chess is a separate POST and does not enroll Compass.
- `chess.profile_id` is set inside the database from the opaque token, for that transaction only.
- Saved bot games store the PGN, starting position, every ply, and the configured engine target. `rated` must be false.
- Automatic saving defaults off. A discarded game is not saved later.
- A copy in `localStorage` is labeled as device recovery, not an account save.

## Suspension

`chess_service.chess_revoke_master` is granted only to `chess_authority`. That role stays `NOLOGIN`, has no password, and is not used by the Worker or Hyperdrive. `chess_server` cannot call it. From the database owner session, switch to the authority role for the statement and switch back. This is an admin SQL action, not a Worker request:

```sql
set role chess_authority;
select chess_service.chess_revoke_master('MASTER_USER_UUID');
reset role;
```

That revokes Chess sessions for that master id. Chess does not publish the master id. Idle sessions expire after 30 minutes, and absolute sessions expire after 12 hours. The Worker scheduled event calls `chess_service.chess_cleanup()` to remove expired rows.
