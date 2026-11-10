import { IOS_PUSH_NOTE, PUSH_KINDS, VAPID_PUBLIC_KEY } from './push-config.js';

export function pushSupport(source) {
  const agent = String(source && source.userAgent || '');
  const ios = /iPhone|iPad|iPod/i.test(agent);
  const standalone = !!(source && source.standalone);
  const pushManager = !!(source && source.pushManager);
  if (!pushManager && ios && !standalone) return { ok: false, reason: 'ios', note: IOS_PUSH_NOTE };
  if (!pushManager) return { ok: false, reason: 'unsupported', note: 'This browser cannot show Chess notifications.' };
  return { ok: true, reason: '', note: '' };
}

function urlBase64ToBytes(value) {
  const source = String(value || '');
  const padded = source.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - source.length % 4) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function button(label) {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = 'tool';
  node.textContent = label;
  return node;
}

export function currentPushSupport() {
  const media = typeof window.matchMedia === 'function' ? window.matchMedia('(display-mode: standalone)') : null;
  const nav = window.navigator || {};
  const standalone = !!(media && media.matches) || nav.standalone === true;
  return pushSupport({
    userAgent: nav.userAgent,
    standalone,
    pushManager: 'PushManager' in window && nav.serviceWorker
  });
}

export async function enablePush(gateway) {
  const support = currentPushSupport();
  if (!support.ok) return support;
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: 'denied', note: 'Notifications stay off until you allow them.' };
  const config = await gateway.pushConfig();
  const key = config && config.publicKey ? config.publicKey : VAPID_PUBLIC_KEY;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToBytes(key)
  });
  const profile = await gateway.profile();
  await gateway.savePushSubscription(subscription.toJSON(), profile && profile.id);
  return { ok: true, reason: '', note: 'Notifications are on for this device.' };
}

export function mountPushPrompt(parent, gateway) {
  const support = currentPushSupport();
  if (!support.ok && support.reason === 'ios') {
    parent.append(note(support.note));
    return;
  }
  const control = button('Turn on notifications');
  control.id = 'push-enable';
  const status = document.createElement('p');
  status.className = 'community-note';
  control.addEventListener('click', () => {
    enablePush(gateway).then((result) => {
      status.textContent = result.note || (result.ok ? 'Notifications are on for this device.' : 'Notifications were not turned on.');
    }).catch(() => {
      status.textContent = 'Notifications were not turned on.';
    });
  });
  parent.append(control, status);
}

export function mountPushSettings(parent, gateway) {
  const section = document.createElement('section');
  section.id = 'push-settings';
  const heading = document.createElement('h3');
  heading.textContent = 'Notification settings';
  section.append(heading);
  mountPushPrompt(section, gateway);
  const list = document.createElement('div');
  list.className = 'community-tools';
  PUSH_KINDS.forEach(([kind, label]) => {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tool';
    toggle.setAttribute('data-kind', kind);
    toggle.textContent = label + ': on';
    toggle.addEventListener('click', () => {
      const enabled = toggle.textContent.endsWith('off');
      gateway.savePushPreference(kind, enabled).then(() => {
        toggle.textContent = label + ': ' + (enabled ? 'on' : 'off');
      }).catch(() => {});
    });
    list.append(toggle);
  });
  const test = button('Send a test notification');
  test.id = 'push-test';
  test.addEventListener('click', () => {
    gateway.sendTestPush().catch(() => {});
  });
  section.append(list, test);
  parent.append(section);
  if (typeof gateway.pushSettings !== 'function' || typeof list.querySelectorAll !== 'function') return;
  gateway.pushSettings().then((settings) => {
    list.querySelectorAll('button').forEach((toggle) => {
      const kind = toggle.getAttribute('data-kind');
      const label = PUSH_KINDS.find((item) => item[0] === kind);
      const enabled = !settings || settings[kind] !== false;
      toggle.textContent = (label ? label[1] : kind) + ': ' + (enabled ? 'on' : 'off');
    });
  }).catch(() => {});
}

function note(text) {
  const node = document.createElement('p');
  node.className = 'community-note';
  node.textContent = text;
  return node;
}
