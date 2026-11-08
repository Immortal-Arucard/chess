import { assertPublishable, communityConfig } from './community-config.js';
import { createSupabaseGateway } from './community-supabase.js';
import { mountCommunity } from './community-view.js';

const root = document.getElementById('community-app');
const config = communityConfig();

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
  mountCommunity(root, { configured: false });
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
    mountCommunity(root, { configured: true, gateway });
    gateway.listen();
  }).catch((error) => {
    root.textContent = error.message || 'Community sign-in could not start.';
  });
}
