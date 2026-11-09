import { httpsUrl, masterLook, masterMenu } from './master-account.js';

// A section describes one sub-site account. The header shows that local look
// only when the section is registered and hasLocalAccount(session) is true.
// Otherwise the shared master look is used.
//
// sectionId: string
// label: string
// hasLocalAccount(session): boolean
// localProfile(session): { name, avatarUrl, portraitId, profileUrl }
// joinItem: { label, href } shown on the master menu when the user has no local account
// localMenu(session): [{ id, label, href }]
export function resolveAccountLook(section, session) {
  if (!session || session.authenticated !== true) return { kind: 'signed-out' };
  if (section && typeof section.hasLocalAccount === 'function' && section.hasLocalAccount(session)) {
    const local = section.localProfile(session) || {};
    const menu = Array.isArray(section.localMenu && section.localMenu(session)) ? section.localMenu(session).slice() : [];
    menu.push({ id: 'sign-out', label: 'Sign out', action: 'sign-out' });
    return {
      kind: 'local',
      sectionId: String(section.sectionId || ''),
      name: String(local.name || 'Member'),
      avatarUrl: httpsUrl(local.avatarUrl),
      portraitId: String(local.portraitId || ''),
      profileUrl: String(local.profileUrl || ''),
      menu
    };
  }
  const look = masterLook(session.master);
  return {
    kind: 'master',
    sectionId: section ? String(section.sectionId || '') : '',
    name: look.name,
    avatarUrl: look.avatarUrl,
    initials: look.initials,
    portraitId: '',
    profileUrl: '',
    menu: masterMenu(section && section.joinItem)
  };
}
