# Chess community backend

This migration has not been applied. The Chess site does not contain a database password or a service-role key. Do not merge the community client onto the live site until the steps below are done and a signed-in post can be created and deleted by its author.

## What Compass already does

The public Compass site loads `@supabase/supabase-js` and a publishable key. It signs in with email magic links (`flowType: pkce`) and stores Compass results in `profiles`, `results`, and `test_events`. Those tables are not a community. Chess must not write to them.

This proposal does not verify that project's row-level policies, auth settings, or quota. Confirm those in the dashboard before choosing it.

## Project choice

Use the existing Compass Supabase project only if one shared login is acceptable: a Compass account and a Chess account would be the same `auth.users` row. Chess display names still live in `chess_profiles`, not in Compass `profiles`.

Use a separate Supabase project if Chess identities must stay separate. Either choice uses the free project already available to the parent. This design adds no storage bucket, edge function, realtime publication, or paid add-on.

## Parent steps before the page can store posts

1. Open the chosen project as its owner. In Authentication, confirm email magic links are enabled.
2. Set Site URL to `https://chess.theworldgovernmentincorporated.com` if this project is only for Chess. If the project is shared with Compass, leave Compass's Site URL in place.
3. Add these redirect URLs:
   - `https://chess.theworldgovernmentincorporated.com/community/`
   - `http://127.0.0.1:8773/community/` for a local check
4. Run `supabase/chess_community.sql` once in the SQL editor. It creates only `chess_profiles`, `chess_admins`, `chess_posts`, `chess_replies`, and `chess_reports`, enables and forces row-level security, and grants the minimum table privileges.
5. Open Security Advisor and confirm those five tables are reported as protected by RLS.
6. Create the first admin only from the SQL editor, after that person has signed in once so the user id exists:

```sql
insert into public.chess_admins (user_id) values ('USER_UUID_FROM_AUTH_USERS');
```

The browser cannot insert into `chess_admins`. There is no admin screen in this change. Admins can read every report and set `hidden_at` or delete a post or reply through the SQL editor or a later admin page. Reports are not shown to other members.

7. Copy the project URL and the publishable key into `assets/chess/community-config.js`. The publishable key is the public client key. Refuse any key whose JWT role is `service_role`. Leave both values empty until this list is finished.
8. Deploy the Chess site only after a manual check: magic link lands on `/community/`, a display name saves, a post and reply appear in a second browser, the author can delete them, and another account cannot.

## Authorization rules the SQL enforces

- Display names are public. Only the signed-in user can insert, rename, or delete their `chess_profiles` row, and the id must equal `auth.uid()`.
- Posts and replies require a profile. The author id must equal `auth.uid()`. Hidden rows stay visible to the author and to admins, not to everyone else.
- Members can delete their own posts and replies. Admins can also delete or update them. Ordinary members cannot update post bodies.
- A report must name exactly one post or one reply. The reporter reads only their own reports. Admins read all of them.
- A database trigger rejects an 11th post or a 31st reply from the same author inside ten minutes. Length limits are 40 characters for a display name, 2000 for a post or reply, and 500 for a report reason.
- `user_metadata` is not used in any policy. A display name typed before the magic link is only a browser hint until it is inserted into `chess_profiles`.

## What this change does not do

No direct messages, uploads, payments, marketplace, AMU, or human-versus-human play. No service-role key in the repository. No live post was created for this proposal.
