import assert from 'node:assert/strict';
import { pushSupport } from './push-client.js';
import { IOS_PUSH_NOTE } from './push-config.js';

const ios = pushSupport({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', standalone: false, pushManager: false });
assert.equal(ios.ok, false);
assert.equal(ios.reason, 'ios');
assert.equal(ios.note, IOS_PUSH_NOTE);
const installed = pushSupport({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', standalone: true, pushManager: true });
assert.equal(installed.ok, true);
const desktop = pushSupport({ userAgent: 'Mozilla/5.0', standalone: false, pushManager: false });
assert.equal(desktop.reason, 'unsupported');
console.log('push support tests passed');
