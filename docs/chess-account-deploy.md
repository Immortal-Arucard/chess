# Chess account service deployment

This service is not deployed. Production data was not changed. The live bot remains commit `20d38e8e746e4720e0f6c6a8e7d5d171c77d3661` until this branch is reviewed and merged.

## What the parent runs

1. In the existing Supabase project `xfswvbxuhgqbdqpqiywa`, open the SQL editor as the database owner. Do not use the service-role key from Chess.
2. Run `supabase/chess_release.sql` once. It applies `chess_community.sql`, `chess_service.sql`, and `chess_http.sql` in that order. `pgcrypto` must be in the `extensions` schema. `extensions.digest` is the function the migration calls. `public.digest` is not used.
3. Create a login role `chess_server` with a password if the migration's `NOLOGIN` role is still in place: `alter role chess_server login password '...';` Grant it `connect` on that database only. Do not grant it `chess_api`, `supabase_admin`, or the service role.
4. Store that connection string as a secret named `DATABASE_URL` on the host that runs `node server/listen.mjs`. Do not commit it.
5. Set `CHESS_ORIGIN=https://chess.theworldgovernmentincorporated.com`, `SUPABASE_URL` to the existing project URL, and `SUPABASE_ANON_KEY` to the publishable key. The service calls GoTrue `/auth/v1/otp`, `/auth/v1/token?grant_type=pkce`, and `/auth/v1/user`. It accepts only a provider-issued audience of `authenticated`.
6. Leave the Compass Site URL as it is. Allow `https://chess.theworldgovernmentincorporated.com/api/auth/callback`. The email link lands there, the service completes the session, and it redirects to `/community/` without the code.
7. Create a cache-disabled Hyperdrive configuration for the `chess_server` connection. Hyperdrive is included on the Workers Free plan at 100,000 queries a day. Put that configuration id in `wrangler.jsonc` and deploy the Worker. That deploy is a parent action. This run does not change DNS. GitHub Pages keeps the static site. The service worker does not cache `/api/`.
8. Do not expose `chess_private` in the Data API. Do not put a publishable key or service-role key in the Chess page.

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
select public.chess_revoke_master('MASTER_USER_UUID');
```

That revokes Chess sessions for that master id. Chess does not publish the master id. Idle sessions expire after 30 minutes, and absolute sessions expire after 12 hours. `select public.chess_cleanup();` removes expired rows.
