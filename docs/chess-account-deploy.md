# Chess account service deployment

This service is not deployed. Production data was not changed. The live bot remains commit `20d38e8e746e4720e0f6c6a8e7d5d171c77d3661` until this branch is reviewed and merged.

## What the parent runs

1. In the existing Supabase project `xfswvbxuhgqbdqpqiywa`, open the SQL editor as the database owner and run `supabase/chess_release.sql` once. It is one transaction. Do not use the service-role key from Chess. `pgcrypto` must be in the `extensions` schema. `extensions.digest` is the function the migration calls.
2. Give only `chess_server` a password: `alter role chess_server login password '...';` Grant it `connect` on that database only. Do not grant it `chess_api`, `supabase_admin`, the service role, or `chess_authority`. Leave `chess_authority` as `NOLOGIN`. Do not give it a password.
3. Create a cache-disabled Hyperdrive configuration with the `chess_server` connection string only. Put its id in `wrangler.jsonc` in place of `REPLACE_WITH_CACHE_DISABLED_HYPERDRIVE_ID`. Hyperdrive is included on the Workers Free plan at 100,000 queries a day. Set Worker secrets `CHESS_ORIGIN=https://chess.theworldgovernmentincorporated.com`, `SUPABASE_URL`, and `SUPABASE_ANON_KEY`. Do not commit them. Deploy the Worker whose entry is `server/worker.mjs`, as named by `wrangler.jsonc`. `chess_authority` is not a Worker binding and not a Hyperdrive connection. There is no separate Node host.
4. Leave the Compass Site URL as it is. Allow `https://chess.theworldgovernmentincorporated.com/api/auth/callback`. The email link lands there, the service completes the session, and it redirects to `/community/`.
5. Proxy the chess DNS name and attach the Worker to `/api/*` only. That DNS change is a parent action. This run does not change DNS. GitHub Pages keeps the static site. The service worker does not cache `/api/`.
6. Do not expose `chess_private` in the Data API. Do not put a publishable key or service-role key in the Chess page.

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
