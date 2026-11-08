# Chess community backend

This migration has not been applied. The Chess site does not contain a database password or a service-role key. Do not merge the community client onto the live site until the steps below are done and a signed-in post can be created and deleted by its author.

## What Compass already does

The public Compass site loads `@supabase/supabase-js` and a publishable key. It signs in with email magic links (`flowType: pkce`) and stores Compass results in `profiles`, `results`, and `test_events`. Those tables are not a community. Chess must not write to them.

This proposal does not verify that project's row-level policies, auth settings, or quota. Confirm those in the dashboard before choosing it.

## Account model

Authentication, the master TWGI identity, and a service membership are three different things.

- Authentication is a verified Supabase `auth.users` session. The magic link proves control of that email. Signing in does not join Chess, Compass, or any other service. There is no trigger on `auth.users`.
- The master TWGI identity is that same `auth.users` id. Every Chess profile belongs to exactly one master identity. The person does not opt out of that connection, and Chess does not ask them to.
- Chess membership is a `chess_profiles` row with its own random public id. It is created only when the person submits Join Chess. The public id is the profile URL. It is not the master id.
- The connection is stored only in `chess_private.profile_owners`. That schema is not exposed through the Data API. `anon` and `authenticated` have no select grant on it. Chess pages and the Chess API do not return the master id, the owner row, or any other service. Hiding a field in the browser is not the control; the grants and the unexposed schema are.
- A future master TWGI account, not this site, may show the owner their own service list. That server must check the caller's JWT and read `chess_private` with a service-role key that never ships in Chess. It returns the service name and the public Chess profile id to that owner only.
- Compass membership stays in Compass's own tables. Joining Chess does not create or open it. A menu link to another TWGI page is not account access.
- The same email in two existing account lists is not a link. Do not backfill or merge by email. Someone who already uses Compass is connected to Chess only after they verify the login and explicitly join Chess, which writes a new public Chess id. A different email remains a different master identity until a later verified process exists. That process is not built here.

Recommended stage, at no extra Supabase charge: put these tables in the Supabase project already used by the public Compass client, after the parent confirms that project and that one login pool is acceptable. Chess still does not enroll anyone in Compass. A second auth project is not required now. The Free plan includes two active projects for owners and administrators. Supabase SSO users are unavailable on the Free plan, and each extra project on a paid plan adds compute cost. Separate projects with federated login would make the inherent connection harder and are not this stage.

There is no checkbox. Joining Chess always records the private owner row. The Chess screen does not show that row or any other service.

## Parent steps before the page can store posts

1. Open the chosen project as its owner. In Authentication, confirm email magic links are enabled.
2. Set Site URL to `https://chess.theworldgovernmentincorporated.com` if this project is only for Chess. If the project is shared with Compass, leave Compass's Site URL in place.
3. Add these redirect URLs:
   - `https://chess.theworldgovernmentincorporated.com/community/`
   - `http://127.0.0.1:8773/community/` for a local check
4. In API settings, confirm Exposed schemas do not include `chess_private`.
5. Run `supabase/chess_community.sql` once in the SQL editor. It creates public `chess_profiles`, `chess_posts`, `chess_replies`, and `chess_reports`, plus private `chess_private.profile_owners` and `chess_private.admins`. It enables and forces row-level security on the public tables. Confirm there is no trigger on `auth.users` and no statement that copies Compass rows by email.
6. Open Security Advisor for the public tables. Also confirm the Data API cannot select `chess_private.profile_owners` with the publishable key.
7. Create the first admin only from the SQL editor, using the master auth user id, after that person has signed in once:

```sql
insert into chess_private.admins (owner_id) values ('AUTH_USER_UUID');
```

The Chess API cannot list admins or master ids. Admins can read reports and hide or delete posts through the database. Reports are not shown to other members.

8. Copy the project URL and the publishable key into `assets/chess/community-config.js`. The publishable key is the public client key. Refuse any key whose JWT role is `service_role`. Leave both values empty until this list is finished.
9. Deploy the Chess site only after a manual check: magic link lands on `/community/` and does not by itself create a Chess profile. Join Chess creates one. A post and reply appear in a second browser, the author can delete them, and another account cannot. Open `/community/profile/?id=` plus the public profile id, not the auth user id. The page shows the display name and public posts only. It must not show the email address or the master id. The rename control appears only for the owner. Confirm a publishable-key request to `chess_private.profile_owners` is rejected.

## Authorization rules the SQL enforces

- Public profile columns are `id`, `display_name`, and `created_at`. `id` is random. It is not `auth.uid()`. The profile URL uses that public id. Email is not stored on the profile.
- `chess_private.profile_owners` maps one public profile to one master `auth.users` id. `anon` and `authenticated` cannot select it. Chess calls `chess_join`, `chess_rename`, and `chess_my_profile`, which return only the public columns. A client cannot pass another person's master id and rename their profile.
- Each member has a stable page at `/community/profile/?id=` followed by the public profile id. The page lists that member's public posts, omitting rows with `hidden_at` set. There is no biography column. The signed-in member gets an edit control only when `chess_my_profile` returns that same public id.
- Posts and replies store the public profile id, not the master id. Inserts succeed only when that id is the caller's Chess profile. Hidden rows stay visible to the author and to admins, not to everyone else.
- Members can delete their own posts and replies. Admins can also delete or update them. Ordinary members cannot update post bodies.
- A report must name exactly one post or one reply. The reporter reads only their own reports. Admins read all of them.
- A database trigger rejects an 11th post or a 31st reply from the same author inside ten minutes. Length limits are 40 characters for a display name, 2000 for a post or reply, and 500 for a report reason.
- `user_metadata` is not used in any policy. A display name typed before the magic link is only a browser hint until Join Chess creates the profile. The private owner row is written in that same function, not by matching an email to an existing Compass or Chess account.

## What this change does not do

No direct messages, uploads, payments, marketplace, AMU, or human-versus-human play. No TWGI login is added to Compass or any other repository in this change. No service-role key is in the repository. No live post was created for this proposal.

Before applying the SQL, the parent should inspect the Supabase organization: how many of the two active Free projects are already in use, whether the Compass project is the one that should hold these tables, that email magic links are enabled, and that Supabase SSO stays off. SSO monthly active users are not included on the Free plan.
