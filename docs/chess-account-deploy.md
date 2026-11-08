# Chess account service deployment

The reviewed migration and Worker are already in place. Do not apply the migration again, and do not upload a different Worker bundle over `chess-api`. The live bot on `main` remains `20d38e8e746e4720e0f6c6a8e7d5d171c77d3661`. Community posts, join, and account save are not launched.

## Already applied

- Migration `supabase/chess_release.sql` from `1925b2a8e191dea47b16f6a46cd0aa8caf47d3d9` is applied as Supabase migration version `20261108174719`. Its SHA256 is `2607b715ed5c8c18930748891b0187237a6a7d06ee2ba9200f43b20c8e0e2d7c`. Leave that version in place.
- Worker `chess-api` is deployed from that same commit. The main module SHA256 is `9d460b57856c0e5ef8fb1d5b6aa6ce1b3554a37ed7e68c344f6b45da0d298079`. Compatibility date `2026-11-08`. Flag `nodejs_compat`.
- Hyperdrive `fc681330ac0540309ebf509fdd3f3fa8` is direct, uses role `chess_server`, has caching disabled, and has a maximum of 5 connections. `chess_authority` stays `NOLOGIN` and is not on the Worker or Hyperdrive.
- Data API exposed schemas are `public` and `graphql_public` only. Keep `chess_private` and `chess_service` unexposed.
- The Compass Site URL is unchanged. `https://chess.theworldgovernmentincorporated.com/api/auth/callback` is allowed.
- The route is only `chess.theworldgovernmentincorporated.com/api/*`. The existing CNAME is proxied and GitHub Pages still serves the rest of the site. `workers.dev` and preview URLs are disabled. Query-string log redaction is enabled.
- The account subdomain `theworldgovernmentincorporated.workers.dev` is registered. The cron `*/15 * * * *` was created at 2:12:23 PM EST on 8 November 2026. A cron execution has not been observed yet.
- Anonymous `GET /api/session` and `GET /api/posts` returned 200 with `no-store`. The site root returned 200.
- No auth email, join, private row, or real game save has been tested.

`wrangler.jsonc` in the repository still contains `REPLACE_WITH_CACHE_DISABLED_HYPERDRIVE_ID`. That placeholder is not the live binding. Do not deploy the repository config over the Worker that is already running.

`GET /api/auth/start` returns 405. Sign-in is a POST. The live `/community/` page does not have that form yet.

## Acceptance still open

1. Review and, when accepted, publish only the sign-in page in the separate pull request. It posts `{ email }` to `/api/auth/start` and reads `/api/session`. It does not join, post, or save.
2. Open `/community/` in a normal browser, send the link, and open the email. The callback returns to `/community/` and the page should say the session is signed in and that no Chess profile exists yet. Sign out should return to not signed in.
3. After that session check, the unmerged community branch remains the candidate for an explicit join, then a saved game and board replay. Do not merge it as part of the sign-in check.

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
