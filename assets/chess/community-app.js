import { profileRoute } from './community-model.js';
import { createChessGateway } from './community-gateway.js';
import { mountCommunity, mountProfile } from './community-view.js';

const root = document.getElementById('community-app');
const route = profileRoute(window.location);

function show(configured, gateway) {
  if (route.page === 'profile') {
    mountProfile(root, {
      configured,
      gateway,
      valid: route.valid,
      reason: route.reason,
      profileId: route.id
    });
    return;
  }
  mountCommunity(root, { configured, gateway });
}

fetch('/api/session', { credentials: 'same-origin' }).then((response) => {
  if (!response.ok) throw new Error('unavailable');
  show(true, createChessGateway());
}).catch(() => {
  show(false, null);
});
