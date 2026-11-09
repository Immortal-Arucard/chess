import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { validateGame } from './game-record.mjs';
import { handleHumanGet, handleHumanPost } from './human-api.mjs';
import { sanitizeProfileImage } from './profile-image.mjs';
import { createSupabaseAuth } from './supabase-auth.mjs';

const SESSION_COOKIE = '__Host-chess_session';
const CSRF_COOKIE = 'chess_csrf';
const HANDOFF_COOKIE = '__Host-chess_handoff';
const STATE_COOKIE = '__Host-chess_auth';

export function randomToken() {
  return randomBytes(32).toString('base64url');
}

export function codeChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

function cookieValue(header, name) {
  const parts = String(header || '').split(/;\s*/);
  for (const part of parts) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index) === name) return decodeURIComponent(part.slice(index + 1));
  }
  return '';
}

function setCookie(name, value, { httpOnly, maxAge }) {
  const pieces = [
    name + '=' + encodeURIComponent(value),
    'Path=/',
    'Secure',
    'SameSite=Lax'
  ];
  if (httpOnly) pieces.push('HttpOnly');
  if (maxAge === 0) pieces.push('Max-Age=0');
  else if (maxAge) pieces.push('Max-Age=' + maxAge);
  return pieces.join('; ');
}

function clearCookies() {
  return [
    setCookie(SESSION_COOKIE, '', { httpOnly: true, maxAge: 0 }),
    setCookie(CSRF_COOKIE, '', { httpOnly: false, maxAge: 0 }),
    setCookie(HANDOFF_COOKIE, '', { httpOnly: true, maxAge: 0 }),
    setCookie(STATE_COOKIE, '', { httpOnly: true, maxAge: 0 })
  ];
}

function hashesEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function boundedLimit(value) {
  const number = Number(value || 20);
  if (!Number.isInteger(number) || number < 1) return 20;
  return Math.min(number, 20);
}

function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf && !cf.includes(',')) return cf.trim();
  const remote = String((req.socket && req.socket.remoteAddress) || '');
  if (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') return remote;
  return 'untrusted';
}

function publicError(error) {
  const message = String((error && error.message) || '').split('\n')[0];
  const allowed = [
    'Sign-in could not start.',
    'Sign-in could not be completed.',
    'Sign-in expired.',
    'The account service could not send a sign-in link.',
    'Google sign-in could not start.',
    'This account is suspended.',
    'Join Chess before doing that.',
    'A discussion message must be 1 to 1000 characters.',
    'You can discuss only as your own Chess profile.',
    'You can edit only your own Chess profile.',
    'A bio can be at most 280 characters.',
    'Use a JPEG, PNG, or WebP image up to 512 KB.',
    'Sign in before joining Chess.',
    'Sign in before doing that.',
    'Enter a display name of 1 to 40 characters.',
    'You can post only as your own Chess profile.',
    'You can reply only as your own Chess profile.',
    'You can delete only your own post.',
    'You can delete only your own reply.',
    'Only an admin can hide this.',
    'This game was already saved with different moves.',
    'This game belongs to a different Chess account.',
    'A saved game must include every move.',
    'Chess does not store a rated result.',
    'The move list does not replay.',
    'The PGN does not match the move list.',
    'The PGN does not match the starting position.',
    'The result does not match the position.',
    'The starting position is missing.',
    'The game record is incomplete.',
    'The game record is too long.',
    'That appearance is not one of the saved choices.',
    'That engine target is not one of the saved choices.',
    'The player side is missing.',
    'The ending is not one this service stores.',
    'A resignation needs a winner.',
    'A finished position is not a resignation.',
    'The request is too large.',
    'The request origin is not this Chess site.',
    'The security token did not match this session.',
    'That profile was not found.',
    'This account has reached the saved-game limit.',
    'That time control is not available.',
    'Choose white, black, or random.',
    'Choose a Chess member to challenge.',
    'You cannot claim your own challenge.',
    'That challenge is no longer open.',
    'It is not your turn.',
    'That move is not legal.',
    'That game was not found.',
    'The board changed. Reload this game.',
    'You can play only as your own Chess profile.',
    'You can abort only before the first move.',
    'That draw offer is not open.',
    'A dialogue message must be 1 to 500 characters.',
    'You can write in this game only as a player.',
    'This dialogue is already saved with your game.',
    'Enter at least 2 characters of a display name.',
    'You already have too many open challenges.'
  ];
  if (message.startsWith('Too many ') && message.length < 80) return message;
  if (allowed.includes(message)) return message;
  return 'The request could not be completed.';
}

function imageBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string' && value.startsWith('\\x') && /^\\x[0-9a-fA-F]*$/.test(value) && value.length % 2 === 0) {
    return Buffer.from(value.slice(2), 'hex');
  }
  return null;
}

async function readBounded(req, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error('Use a JPEG, PNG, or WebP image up to 512 KB.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw new Error('The request is too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const AUTH_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff'
};

export function createChessApp({ pool, origin, supabaseUrl, supabaseKey, fetchImpl }) {
  const master = createSupabaseAuth({ url: supabaseUrl, apiKey: supabaseKey, fetchImpl: fetchImpl || fetch });
  async function query(text, params) {
    const client = await pool.connect();
    try {
      const who = await client.query('select current_user as role');
      if (who.rows[0].role !== 'chess_server') {
        throw new Error('The Chess service connected as ' + who.rows[0].role + '.');
      }
      await client.query('begin');
      await client.query("set local statement_timeout = '3s'");
      const result = await client.query(text, params);
      await client.query('commit');
      return result;
    } catch (error) {
      try { await client.query('rollback'); } catch (ignore) { /* already closed */ }
      throw error;
    } finally {
      try { await client.query("select set_config('chess.profile_id', '', false)"); } catch (ignore) { /* reset best effort */ }
      client.release();
    }
  }

  function allowsMutation(req) {
    return req.headers.origin === origin;
  }

  async function csrfOk(req, token) {
    const sent = String(req.headers['x-csrf-token'] || '');
    const cookie = cookieValue(req.headers.cookie, CSRF_COOKIE);
    if (!sent || sent !== cookie) return false;
    const result = await query('select chess_service.chess_csrf_hash($1) as hash', [token]);
    const expected = result.rows[0] && result.rows[0].hash;
    if (!expected) return false;
    const actual = createHash('sha256').update(sent).digest('hex');
    return hashesEqual(actual, expected);
  }

  async function handle(req, res) {
    const url = new URL(req.url, origin);
    const token = cookieValue(req.headers.cookie, SESSION_COOKIE);
    const send = (status, body, extraHeaders) => {
      const headers = Object.assign({
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer'
      }, extraHeaders);
      res.writeHead(status, headers);
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'GET' && url.pathname === '/api/session') {
        const csrf = randomToken();
        const headers = { 'set-cookie': setCookie(CSRF_COOKIE, csrf, { httpOnly: false, maxAge: 600 }) };
        if (!token) return send(200, { authenticated: false, profile: null, configured: true }, headers);
        const result = await query('select chess_service.chess_session($1) as session', [token]);
        const session = result.rows[0].session;
        return send(200, Object.assign({ configured: true }, session));
      }
      if (req.method === 'GET' && url.pathname === '/api/discussion') {
        const result = await query('select chess_service.discussion_page($1, $2, $3, $4, $5) as messages', [
          url.searchParams.get('before') || null,
          url.searchParams.get('beforeId') || null,
          url.searchParams.get('after') || null,
          url.searchParams.get('afterId') || null,
          boundedLimit(url.searchParams.get('limit'))
        ]);
        return send(200, { messages: result.rows[0].messages, limit: boundedLimit(url.searchParams.get('limit')) });
      }
      if (req.method === 'GET' && url.pathname === '/api/posts') {
        const limit = boundedLimit(url.searchParams.get('limit'));
        const result = await query('select chess_service.posts($1, $2, $3, $4, $5) as posts', [
          token || null, null, url.searchParams.get('before') || null, url.searchParams.get('beforeId') || null, limit
        ]);
        return send(200, { posts: result.rows[0].posts, limit });
      }
      const profileMatch = url.pathname.match(/^\/api\/profiles\/([0-9a-f-]{36})$/i);
      const authorPosts = url.pathname.match(/^\/api\/profiles\/([0-9a-f-]{36})\/posts$/i);
      const profileImage = url.pathname.match(/^\/api\/profiles\/([0-9a-f-]{36})\/(portrait|background)$/i);
      if (req.method === 'GET' && profileImage) {
        const result = await query('select mime, bytes from chess_service.profile_image($1, $2)', [profileImage[1], profileImage[2]]);
        const image = result.rows[0];
        const bytes = imageBytes(image && image.bytes);
        if (!bytes || !bytes.length || !['image/jpeg', 'image/png', 'image/webp'].includes(image && image.mime)) {
          return send(404, { error: 'That profile was not found.' });
        }
        res.writeHead(200, {
          'content-type': image.mime,
          'content-length': bytes.length,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer'
        });
        res.end(bytes);
        return;
      }
      if (req.method === 'GET' && profileMatch) {
        const result = await query('select chess_service.profile($1) as profile', [profileMatch[1]]);
        if (!result.rows[0].profile) return send(404, { error: 'That profile was not found.' });
        return send(200, result.rows[0].profile);
      }
      if (req.method === 'GET' && authorPosts) {
        const limit = boundedLimit(url.searchParams.get('limit'));
        const result = await query('select chess_service.posts($1, $2, $3, $4, $5) as posts', [
          token || null, authorPosts[1], url.searchParams.get('before') || null, url.searchParams.get('beforeId') || null, limit
        ]);
        return send(200, { posts: result.rows[0].posts, limit });
      }
      if (req.method === 'GET' && url.pathname === '/api/auth/callback') {
        const authRedirect = (notice) => {
          res.writeHead(303, Object.assign({
            location: origin + '/community/?auth=' + encodeURIComponent(notice),
            'set-cookie': [
              setCookie(STATE_COOKIE, '', { httpOnly: true, maxAge: 0 }),
              setCookie(HANDOFF_COOKIE, '', { httpOnly: true, maxAge: 0 })
            ]
          }, AUTH_HEADERS));
          res.end();
        };
        try {
          if (url.searchParams.get('error')) return authRedirect('rejected');
          const state = cookieValue(req.headers.cookie, STATE_COOKIE);
          const code = String(url.searchParams.get('code') || '');
          if (!state) return authRedirect('browser');
          if (!code) return authRedirect('rejected');
          const consumed = await query('select verifier, redirect_uri from chess_service.consume_auth($1)', [state]);
          const row = consumed.rows[0];
          if (!row) return authRedirect('expired');
          if (row.redirect_uri !== origin + '/api/auth/callback') return authRedirect('rejected');
          const exchange = await master.exchange({ code, verifier: row.verifier });
          if (!exchange || exchange.audience !== 'authenticated' || !exchange.masterId) return authRedirect('rejected');
          const sessionToken = randomToken();
          const csrf = randomToken();
          await query('select chess_service.complete_login($1, $2, $3)', [exchange.masterId, sessionToken, csrf]);
          res.writeHead(303, Object.assign({
            location: origin + '/community/',
            'set-cookie': [
              setCookie(SESSION_COOKIE, sessionToken, { httpOnly: true, maxAge: 60 * 60 * 12 }),
              setCookie(CSRF_COOKIE, csrf, { httpOnly: false, maxAge: 60 * 60 * 12 }),
              setCookie(STATE_COOKIE, '', { httpOnly: true, maxAge: 0 }),
              setCookie(HANDOFF_COOKIE, '', { httpOnly: true, maxAge: 0 })
            ]
          }, AUTH_HEADERS));
          res.end();
          return;
        } catch (err) {
          return authRedirect('rejected');
        }
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/human')) {
        const human = await handleHumanGet({ url, token, query, send });
        if (human !== false) return;
      }
      if (req.method !== 'POST') return send(405, { error: 'Method not allowed.' });
      if (!allowsMutation(req)) return send(403, { error: 'The request origin is not this Chess site.' });
      if (url.pathname === '/api/auth/start') {
        const body = await readJson(req);
        const email = String(body.email || '');
        const state = randomToken();
        const verifier = randomToken();
        const challenge = codeChallenge(verifier);
        const redirectTo = origin + '/api/auth/callback';
        await query('select chess_service.begin_sign_in($1, $2, $3, $4, $5, $6)', [
          email, state, verifier, challenge, redirectTo, clientIp(req)
        ]);
        await master.sendMagicLink({ email, challenge, redirectTo });
        return send(200, { sent: true }, {
          'set-cookie': setCookie(STATE_COOKIE, state, { httpOnly: true, maxAge: 600 })
        });
      }
      if (url.pathname === '/api/auth/google') {
        const state = randomToken();
        const verifier = randomToken();
        const challenge = codeChallenge(verifier);
        const redirectTo = origin + '/api/auth/callback';
        const marker = randomToken().slice(0, 20) + '@oauth.chess.invalid';
        await query('select chess_service.begin_sign_in($1, $2, $3, $4, $5, $6)', [
          marker, state, verifier, challenge, redirectTo, clientIp(req)
        ]);
        const providerUrl = await master.startGoogle({ challenge, redirectTo });
        return send(200, { url: providerUrl }, {
          'set-cookie': setCookie(STATE_COOKIE, state, { httpOnly: true, maxAge: 600 })
        });
      }
      if (!token) return send(401, { error: 'Sign in before doing that.' });
      const sessionCheck = await query('select chess_service.chess_session($1) as session', [token]);
      if (!sessionCheck.rows[0].session.authenticated) return send(401, { error: 'Sign in before doing that.' });
      if (!(await csrfOk(req, token))) return send(403, { error: 'The security token did not match this session.' });
      if (url.pathname === '/api/profile/portrait' || url.pathname === '/api/profile/background') {
        const kind = url.pathname.endsWith('portrait') ? 'portrait' : 'background';
        const authorId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(req.headers['x-chess-profile'] || ''))
          ? String(req.headers['x-chess-profile'])
          : null;
        const raw = await readBounded(req, 524288);
        if (!raw.length) {
          await query('select chess_service.clear_profile_image($1, $2, $3)', [token, authorId, kind]);
          return send(200, { cleared: true });
        }
        const declared = String(req.headers['content-type'] || '');
        const image = sanitizeProfileImage(raw, declared);
        await query('select chess_service.set_profile_image($1, $2, $3, $4, $5)', [token, authorId, kind, image.type, image.bytes]);
        return send(200, { saved: true, mime: image.type });
      }
      const body = await readJson(req);
      if (url.pathname === '/api/profile/bio') {
        const authorId = typeof body.authorId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.authorId) ? body.authorId : null;
        const result = await query('select chess_service.set_profile_bio($1, $2, $3) as profile', [token, authorId, body.bio]);
        return send(200, result.rows[0].profile);
      }
      if (url.pathname === '/api/logout') {
        await query('select chess_service.chess_logout($1)', [token]);
        return send(200, { authenticated: false }, { 'set-cookie': clearCookies() });
      }
      if (url.pathname === '/api/join') {
        const result = await query('select chess_service.chess_join($1, $2) as profile', [token, body.displayName]);
        return send(200, result.rows[0].profile);
      }
      if (url.pathname === '/api/profile/rename') {
        const authorId = typeof body.authorId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.authorId) ? body.authorId : null;
        const result = await query('select chess_service.chess_rename($1, $2, $3) as profile', [token, authorId, body.displayName]);
        return send(200, result.rows[0].profile);
      }
      if (url.pathname === '/api/discussion') {
        const authorId = typeof body.authorId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.authorId) ? body.authorId : null;
        const result = await query('select chess_service.discussion_send($1, $2, $3) as message', [token, body.body, authorId]);
        return send(200, result.rows[0].message);
      }
      if (url.pathname === '/api/posts') {
        const result = await query('select chess_service.chess_create_post($1, $2) as post', [token, body.body]);
        return send(200, result.rows[0].post);
      }
      if (url.pathname === '/api/posts/delete') {
        const result = await query('select chess_service.chess_delete_post($1, $2) as deleted', [token, body.id]);
        return send(200, result.rows[0].deleted);
      }
      if (url.pathname === '/api/replies') {
        const result = await query('select chess_service.chess_create_reply($1, $2, $3) as reply', [token, body.postId, body.body]);
        return send(200, result.rows[0].reply);
      }
      if (url.pathname === '/api/replies/list') {
        const result = await query('select chess_service.reply_page($1, $2, $3, $4, $5) as replies', [
          token, body.postId, body.before || null, body.beforeId || null, boundedLimit(body.limit)
        ]);
        return send(200, { replies: result.rows[0].replies, limit: boundedLimit(body.limit) });
      }
      if (url.pathname === '/api/replies/delete') {
        const result = await query('select chess_service.chess_delete_reply($1, $2) as deleted', [token, body.id]);
        return send(200, result.rows[0].deleted);
      }
      if (url.pathname === '/api/reports') {
        const result = await query('select chess_service.chess_report($1, $2, $3, $4) as report', [token, body.postId || null, body.replyId || null, body.reason]);
        return send(200, result.rows[0].report);
      }
      if (url.pathname === '/api/moderate/hide') {
        const result = await query('select chess_service.chess_hide_post($1, $2) as hidden', [token, body.id]);
        return send(200, result.rows[0].hidden);
      }
      if (url.pathname === '/api/settings') {
        if (body.autoSaveBotResults !== undefined) {
          await query('select chess_service.chess_settings_set($1, $2) as settings', [token, body.autoSaveBotResults === true]);
        }
        if (body.autoRecordHumanChat !== undefined) {
          await query('select chess_service.human_record_setting_set($1, $2) as settings', [token, body.autoRecordHumanChat === true]);
        }
        const result = await query('select chess_service.chess_settings($1) as settings', [token]);
        return send(200, result.rows[0].settings);
      }
      if (url.pathname === '/api/games') {
        const hash = validateGame(body);
        if (!body.expectedProfileId) throw new Error('This game belongs to a different Chess account.');
        const result = await query('select chess_service.save_game($1, $2::jsonb, $3) as saved', [token, JSON.stringify(body), hash]);
        return send(200, result.rows[0].saved);
      }
      if (url.pathname.startsWith('/api/human')) {
        const human = await handleHumanPost({ url, token, body, query, send });
        if (human !== false) return;
      }
      if (url.pathname === '/api/games/list') {
        const result = await query('select chess_service.game_page($1, $2, $3, $4) as games', [
          token, body.before || null, body.beforeId || null, boundedLimit(body.limit)
        ]);
        return send(200, { games: result.rows[0].games, limit: boundedLimit(body.limit) });
      }
      return send(404, { error: 'Not found.' });
    } catch (error) {
      return send(400, { error: publicError(error) });
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'The Chess service failed.' }));
      void error;
    });
  });
  return { server, handle, query };
}

