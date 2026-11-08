// Fill these only after supabase/chess_community.sql has been applied.
// Use the project URL and the publishable key. Never put a service-role key here.
export const CHESS_SUPABASE_URL = '';
export const CHESS_SUPABASE_PUBLISHABLE_KEY = '';

export function communityConfig() {
  const url = String(CHESS_SUPABASE_URL || '').trim();
  const key = String(CHESS_SUPABASE_PUBLISHABLE_KEY || '').trim();
  return {
    url,
    key,
    configured: url.startsWith('https://') && url.includes('.supabase.co') && key.length > 0
  };
}

export function assertPublishable(key) {
  if (/service_role/i.test(key)) {
    throw new Error('Refusing a service role key in the browser.');
  }
  const parts = String(key).split('.');
  if (parts.length !== 3) return;
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(padded + '='.repeat((4 - padded.length % 4) % 4));
    const payload = JSON.parse(json);
    if (payload.role === 'service_role') {
      throw new Error('Refusing a service role key in the browser.');
    }
  } catch (error) {
    if (String(error.message).includes('Refusing')) throw error;
  }
}
