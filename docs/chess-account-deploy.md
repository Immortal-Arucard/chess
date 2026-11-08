# Chess account service deployment

This service is not deployed. Production data was not changed. The live bot remains commit `20d38e8e746e4720e0f6c6a8e7d5d171c77d3661` until this branch is reviewed and merged.

## What the parent runs

1. In the existing Supabase project `xfswvbxuhgqbdqpqiywa`, open the SQL editor as the database owner and run `supabase/chess_release.sql` once. It is one transaction. Do not use the service-role key from Chess. `pgcrypto` must be in the `extensions` schema. `extensions.digest` is the function the migration calls.
2. Give `chess_server` a password: `alter role chess_server login password '...';` Grant it `connect` on that database only. Do not grant it `chess_api`, `supabase_admin`, or the service role. Give `chess_authority` its own password the same way. It is the only role that can revoke a master.
3. Create a cache-disabled Hyperdrive configuration with the `chess_server` connection string. Put its id in `wrangler.jsonc`. Hyperdrive is included on the Workers Free plan at 100,000 queries a day. Set Worker secrets `CHESS_ORIGIN=https://chess.theworldgovernmentincorporated.com`, `SUPABASE_URL`, and `SUPABASE_ANON_KEY`. Do not commit them. Deploy `server/worker.mjs`. There is no separate Node host.
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

When a master account is suspended, run as `chess_server`:

```sql
select chess_service.chess_revoke_master('MASTER_USER_UUID');
```

Run that as `chess_authority`, which is the only role granted the function. `chess_server` cannot call it. That revokes Chess sessions for that master id. Chess does not publish the master id. Idle sessions expire after 30 minutes, and absolute sessions expire after 12 hours. The Worker scheduled event calls `chess_service.chess_cleanup()` to remove expired rows.
