# Bot game records and account settings

This is a plan for the Chess account service. It is not applied to any database. The page does not save games to an account, and it does not store this setting or these records in localStorage.

## What "result" means

A saved result is the whole game, not the outcome alone. The record has to be enough to replay every ply and reach the same final position and result.

Each record contains:

- Canonical PGN, including the ordered movetext. Promotions, castling, and en passant stay in that movetext.
- The starting position. Standard games use the normal initial position. Any other start also stores `SetUp` and `FEN` in the PGN.
- The result (`1-0`, `0-1`, or `1/2-1/2`) and how the game ended (checkmate, draw reason, or resign).
- Who played which color, the opponent name `Stockfish 19 Lite`, and the configured `UCI_Elo` target. That target is an uncalibrated engine limit, not a verified rating and not a result from a rated site.
- An ordered move list (`ply`, SAN, UCI, position after the ply) that must match a replay of the PGN.

A summary that keeps only the winner, or only the result tag, is rejected.

## Account setting

`auto_save_bot_results` belongs to the Chess account. It is off by default. It is not a device preference.

When it is on, each bot game that ends while that account is signed in is saved once, whether it is a win, loss, draw, or resignation. When it is off, the player uses Save to account or Discard.

If the setting cannot be loaded, it stays off. A failed load does not save the game.

Discard applies only to the finished game still on screen. It does not delete older saved games, and those discarded games are not saved later when the setting is turned on.

The game is bound to the account that was signed in when it started. A later sign-in does not receive that game. Only the owner of that Chess account can read or write the setting and the games.

## Save behavior

The browser keeps the full record in memory until a save succeeds or the player discards it. A failure, an offline request, or an unavailable service leaves that same record unsaved. Retry sends the same game id and the same PGN. The service stores a game id once per account. A second success does not create a second copy.

PGN download is a separate file download. It is not an account save.

## Service shape

The Chess browser must not hold the master TWGI session. A future Chess service accepts an opaque Chess session and uses that session's public profile id.

Not applied:

```sql
-- chess_private.bot_result_settings
--   profile_id uuid primary key
--   auto_save_bot_results boolean not null default false
--
-- chess_private.bot_games
--   id uuid primary key
--   profile_id uuid not null
--   client_game_id uuid not null
--   pgn text not null
--   start_fen text not null
--   result text not null
--   termination text not null
--   player_color text not null
--   opponent_name text not null
--   opponent_uci_elo integer not null
--   rated boolean not null default false
--   unique (profile_id, client_game_id)
```

The service checks that the PGN replays to the stored move list, final position, and result before it accepts the row. `rated` stays false. No row is written by this repository yet.

## Current page

Account saving and the automatic-save setting are unavailable. The bot page explains that, leaves the setting off, and keeps Save to account from reporting success. Appearance and bot-limit choices still use the device preference `chess.bot.preferences`. That preference is not game history and not the account setting.
