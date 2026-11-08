import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

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

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createChessApp({ pool, origin, audience, masterAuthorize, exchangeCode }) {
  async function query(text, params) {
    const client = await pool.connect();
    try {
      const who = await client.query('select current_user as role');
      if (who.rows[0].role !== 'chess_server') {
        throw new Error('The Chess service connected as ' + who.rows[0].role + '.');
      }
      await client.query('begin');
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
    const result = await query('select public.chess_csrf_hash($1) as hash', [token]);
    const expected = result.rows[0] && result.rows[0].hash;
    if (!expected) return false;
    const actual = createHash('sha256').update(sent).digest('hex');
    return hashesEqual(actual, expected);
  }

  async function handle(req, res) {
    const url = new URL(req.url, origin);
    const token = cookieValue(req.headers.cookie, SESSION_COOKIE);
    const send = (status, body, extraHeaders) => {
      const headers = Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, extraHeaders);
      res.writeHead(status, headers);
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'GET' && url.pathname === '/api/session') {
        const csrf = randomToken();
        const headers = { 'set-cookie': setCookie(CSRF_COOKIE, csrf, { httpOnly: false, maxAge: 600 }) };
        if (!token) return send(200, { authenticated: false, profile: null, configured: true }, headers);
        const result = await query('select public.chess_session($1) as session', [token]);
        const session = result.rows[0].session;
        return send(200, Object.assign({ configured: true }, session));
      }
      if (req.method === 'GET' && url.pathname === '/api/posts') {
        const result = await query('select public.chess_posts($1, $2, $3, $4) as posts', [token || null, null, null, 20]);
        return send(200, { posts: result.rows[0].posts });
      }
      if (req.method === 'GET' && url.pathname === '/api/auth/callback') {
        const state = String(url.searchParams.get('state') || '');
        const code = String(url.searchParams.get('code') || '');
        const cookieState = cookieValue(req.headers.cookie, STATE_COOKIE);
        if (!state || state !== cookieState || !code) {
          res.writeHead(303, { location: origin + '/community/', 'set-cookie': clearCookies() });
          res.end();
          return;
        }
        const handoff = randomToken();
        await query('select public.chess_keep_code($1, $2, $3)', [state, code, handoff]);
        res.writeHead(303, {
          location: origin + '/community/',
          'set-cookie': [
            setCookie(HANDOFF_COOKIE, handoff, { httpOnly: true, maxAge: 300 }),
            setCookie(STATE_COOKIE, '', { httpOnly: true, maxAge: 0 })
          ]
        });
        res.end();
        return;
      }
      if (req.method !== 'POST') return send(405, { error: 'Method not allowed.' });
      if (!allowsMutation(req)) return send(403, { error: 'The request origin is not this Chess site.' });
      if (url.pathname === '/api/auth/start') {
        const body = await readJson(req);
        const state = randomToken();
        const verifier = randomToken();
        const challenge = codeChallenge(verifier);
        await query('select public.chess_begin_auth($1, $2, $3, $4, $5, $6)', [
          state, verifier, challenge, audience, origin + '/api/auth/callback', String(body.loginHint || '')
        ]);
        const redirect = new URL(masterAuthorize);
        redirect.searchParams.set('response_type', 'code');
        redirect.searchParams.set('code_challenge', challenge);
        redirect.searchParams.set('code_challenge_method', 'S256');
        redirect.searchParams.set('state', state);
        redirect.searchParams.set('audience', audience);
        redirect.searchParams.set('redirect_uri', origin + '/api/auth/callback');
        if (body.loginHint) redirect.searchParams.set('login_hint', String(body.loginHint));
        return send(200, { redirect: redirect.toString() }, {
          'set-cookie': setCookie(STATE_COOKIE, state, { httpOnly: true, maxAge: 600 })
        });
      }
      if (url.pathname === '/api/auth/finish') {
        const handoff = cookieValue(req.headers.cookie, HANDOFF_COOKIE);
        const taken = await query('select code, verifier, audience, redirect_uri from public.chess_finish_material($1)', [handoff]);
        const row = taken.rows[0];
        if (!row || !row.code || row.audience !== audience || row.redirect_uri !== origin + '/api/auth/callback') {
          return send(401, { error: 'Sign-in expired.' }, { 'set-cookie': clearCookies() });
        }
        const exchange = await exchangeCode({ code: row.code, verifier: row.verifier, audience: row.audience, redirectUri: row.redirect_uri });
        if (!exchange || exchange.audience !== audience || !exchange.masterId) {
          return send(401, { error: 'Sign-in could not be completed.' }, { 'set-cookie': clearCookies() });
        }
        const sessionToken = randomToken();
        const csrf = randomToken();
        await query('select public.chess_accept_login($1, $2, $3)', [exchange.masterId, sessionToken, csrf]);
        return send(200, { authenticated: true, profile: null }, {
          'set-cookie': [
            setCookie(SESSION_COOKIE, sessionToken, { httpOnly: true, maxAge: 60 * 60 * 12 }),
            setCookie(CSRF_COOKIE, csrf, { httpOnly: false, maxAge: 60 * 60 * 12 }),
            setCookie(HANDOFF_COOKIE, '', { httpOnly: true, maxAge: 0 })
          ]
        });
      }
      if (!token) return send(401, { error: 'Sign in before doing that.' });
      if (!(await csrfOk(req, token))) return send(403, { error: 'The security token did not match this session.' });
      const body = await readJson(req);
      if (url.pathname === '/api/logout') {
        await query('select public.chess_logout($1)', [token]);
        return send(200, { authenticated: false }, { 'set-cookie': clearCookies() });
      }
      if (url.pathname === '/api/join') {
        const result = await query('select public.chess_join($1, $2) as profile', [token, body.displayName]);
        return send(200, result.rows[0].profile);
      }
      if (url.pathname === '/api/profile/rename') {
        const result = await query('select public.chess_rename($1, $2) as profile', [token, body.displayName]);
        return send(200, result.rows[0].profile);
      }
      if (url.pathname === '/api/posts') {
        const result = await query('select public.chess_create_post($1, $2) as post', [token, body.body]);
        return send(200, result.rows[0].post);
      }
      if (url.pathname === '/api/posts/delete') {
        const result = await query('select public.chess_delete_post($1, $2) as deleted', [token, body.id]);
        return send(200, result.rows[0].deleted);
      }
      if (url.pathname === '/api/replies') {
        const result = await query('select public.chess_create_reply($1, $2, $3) as reply', [token, body.postId, body.body]);
        return send(200, result.rows[0].reply);
      }
      if (url.pathname === '/api/replies/list') {
        const result = await query('select public.chess_replies($1, $2) as replies', [token, body.postId]);
        return send(200, { replies: result.rows[0].replies });
      }
      if (url.pathname === '/api/replies/delete') {
        const result = await query('select public.chess_delete_reply($1, $2) as deleted', [token, body.id]);
        return send(200, result.rows[0].deleted);
      }
      if (url.pathname === '/api/reports') {
        const result = await query('select public.chess_report($1, $2, $3, $4) as report', [token, body.postId || null, body.replyId || null, body.reason]);
        return send(200, result.rows[0].report);
      }
      if (url.pathname === '/api/moderate/hide') {
        const result = await query('select public.chess_hide_post($1, $2) as hidden', [token, body.id]);
        return send(200, result.rows[0].hidden);
      }
      if (url.pathname === '/api/settings') {
        const result = body.autoSaveBotResults === undefined
          ? await query('select public.chess_settings($1) as settings', [token])
          : await query('select public.chess_settings_set($1, $2) as settings', [token, body.autoSaveBotResults === true]);
        return send(200, result.rows[0].settings);
      }
      if (url.pathname === '/api/games') {
        const result = await query('select public.chess_save_game($1, $2::jsonb) as saved', [token, JSON.stringify(body)]);
        return send(200, result.rows[0].saved);
      }
      if (url.pathname === '/api/games/list') {
        const result = await query('select public.chess_games($1) as games', [token]);
        return send(200, { games: result.rows[0].games });
      }
      return send(404, { error: 'Not found.' });
    } catch (error) {
      const message = error && error.message ? String(error.message).split('\n')[0] : 'The request failed.';
      return send(400, { error: message.replace(/^error:\s*/i, '') });
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

