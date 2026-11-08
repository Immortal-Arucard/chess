function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch (err) {
    return null;
  }
}

export function createSupabaseAuth({ url, apiKey, fetchImpl, expectedAudience = 'authenticated' }) {
  const base = String(url || '').replace(/\/$/, '');
  const fetchFn = fetchImpl;
  async function call(path, options) {
    const endpoint = new URL(path, base + '/');
    const headers = { apikey: apiKey, 'content-type': 'application/json' };
    if (options.bearer) headers.authorization = 'Bearer ' + options.bearer;
    return fetchFn(endpoint, {
      method: options.method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: 'no-store'
    });
  }
  return {
    async sendMagicLink({ email, challenge, redirectTo }) {
      const response = await call('/auth/v1/otp?redirect_to=' + encodeURIComponent(redirectTo), {
        method: 'POST',
        body: {
          email,
          create_user: true,
          code_challenge: challenge,
          code_challenge_method: 's256'
        }
      });
      if (!response.ok) throw new Error('The account service could not send a sign-in link.');
    },
    async exchange({ code, verifier }) {
      const tokenResponse = await call('/auth/v1/token?grant_type=pkce', {
        method: 'POST',
        body: { auth_code: code, code_verifier: verifier }
      });
      const tokenBody = await tokenResponse.json().catch(() => ({}));
      if (!tokenResponse.ok || !tokenBody.access_token) return null;
      const userResponse = await call('/auth/v1/user', {
        method: 'GET',
        bearer: tokenBody.access_token
      });
      const user = await userResponse.json().catch(() => ({}));
      const payload = decodeJwtPayload(tokenBody.access_token);
      if (!userResponse.ok || !user.id || !payload || payload.sub !== user.id) return null;
      const audience = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
      if (audience !== expectedAudience) return null;
      if (payload.iss !== base + '/auth/v1') return null;
      return { masterId: user.id, audience };
    }
  };
}
