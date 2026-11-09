import { profilePath } from './community-model.js';

export const chessSection = {
  sectionId: 'chess',
  label: 'Chess',
  hasLocalAccount(session) {
    return !!(session && session.profile && typeof session.profile.id === 'string' && session.profile.id);
  },
  localProfile(session) {
    const profile = session.profile;
    const name = String(profile.displayName || '').trim() || 'Member';
    return {
      name,
      avatarUrl: '',
      portraitId: profile.id,
      profileUrl: profilePath(profile.id)
    };
  },
  joinItem: { label: 'Join Chess', href: '/community/' },
  localMenu(session) {
    return [{ id: 'profile', label: 'Profile', href: profilePath(session.profile.id) }];
  }
};
