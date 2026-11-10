-- Lock down the security-definer helpers added for messages and push.
-- Apply once after supabase/chess_push.sql. Do not edit the earlier files.
-- PostgreSQL grants EXECUTE to PUBLIC on every new function. These helpers
-- must not be callable by anon, authenticated, chess_api, or chess_server.
-- The migration owner keeps EXECUTE, which is what the security-definer
-- chess_service functions use when they call the helpers.
-- direct_visible is the exception: row-level policies run as the signed-in
-- role, so authenticated needs EXECUTE and nobody else does.

begin;

revoke all on function chess_private.notification_put(uuid, uuid, text, text, text, text, text) from public, anon, authenticated, chess_api, chess_server;
revoke all on function chess_private.record_mentions(uuid, text, uuid) from public, anon, authenticated, chess_api, chess_server;
revoke all on function chess_private.mention_list(uuid) from public, anon, authenticated, chess_api, chess_server;
revoke all on function chess_private.direct_pair(uuid, uuid) from public, anon, authenticated, chess_api, chess_server;

revoke all on function chess_private.direct_visible(uuid, uuid) from public, anon, authenticated, chess_api, chess_server;
grant execute on function chess_private.direct_visible(uuid, uuid) to authenticated;

commit;
