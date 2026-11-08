import { assertPublishable, communityConfig } from './community-config.js';
import { profileRoute } from './community-model.js';
import { createSupabaseGateway } from './community-supabase.js';
import { mountCommunity, mountProfile } from './community-view.js';

const root = document.getElementById('community-app');
const config = communityConfig();
const route = profileRoute(window.location);

function show(gateway) {
  if (route.page === 'profile') {
    mountProfile(root, {
      configured: config.configured,
      gateway,
      valid: route.valid,
      reason: route.reason,
      profileId: route.id
    });
    return;
  }
  mountCommunity(root, { configured: config.configured, gateway });
}

function loadLibrary() {
  if (window.supabase && window.supabase.createClient) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/assets/vendor/supabase.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('The sign-in library did not load.'));
    document.head.append(script);
  });
}

if (!config.configured) {
  show(null);
} else {
  loadLibrary().then(() => {
    assertPublishable(config.key);
    const client = window.supabase.createClient(config.url, config.key, {
      auth: {
        detectSessionInUrl: true,
        persistSession: true,
        autoRefreshToken: true,
        flowType: 'pkce'
      }
    });
    const gateway = createSupabaseGateway(client);
    show(gateway);
    if (route.page === 'feed') gateway.listen();
  }).catch((error) => {
    root.textContent = error.message || 'Community sign-in could not start.';
  });
}
