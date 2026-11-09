import { profilePath } from './community-model.js';

// Chess section descriptor. Field names match assets/account-sections.js,
// the registry copied from the main site.
// host is the production Chess origin. This file does not set pathPrefixes.
// hasLocalAccount and localProfile read only the signed-in caller's Chess
// profile, through the cookie session. They do not accept an access token
// and they do not query by someone else's id.

async function ownProfile(session) {
  const user = session && session.user;
  if (user && Object.prototype.hasOwnProperty.call(user, 'access_token')) {
    throw new Error('The Chess profile check does not take an access token.');
  }
  const response = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error('The Chess profile could not be read.');
  const body = await response.json();
  const profile = body && body.profile;
  if (!profile || typeof profile.id !== 'string' || !profile.id) return null;
  return profile;
}

export const chessSection = {
  sectionId: 'chess',
  label: 'Chess',
  host: 'chess.theworldgovernmentincorporated.com',
  signInUrl: '/community/',
  async hasLocalAccount(session) {
    return !!(await ownProfile(session));
  },
  async localProfile(session) {
    const profile = await ownProfile(session);
    const name = profile && String(profile.displayName || '').trim();
    if (!profile || !name) throw new Error('This user has no Chess profile name.');
    return {
      name,
      avatarUrl: '',
      url: profilePath(profile.id)
    };
  }
};

if (typeof window !== 'undefined' && window.TWGIAccountSections) {
  window.TWGIAccountSections.register(chessSection);
}
