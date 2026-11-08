import { profileRoute } from './community-model.js';
import { mountCommunity, mountProfile } from './community-view.js';

const root = document.getElementById('community-app');
const route = profileRoute(window.location);

// Chess accounts are not available. Do not load a master sign-in library or
// keep a master session in this browser.
if (route.page === 'profile') {
  mountProfile(root, {
    configured: false,
    gateway: null,
    valid: route.valid,
    reason: route.reason,
    profileId: route.id
  });
} else {
  mountCommunity(root, { configured: false, gateway: null });
}
