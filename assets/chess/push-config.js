// Public VAPID key for chess.theworldgovernmentincorporated.com.
// The matching private key is a Worker secret named VAPID_PRIVATE_KEY.
// It is not in this repository. The Worker also reads VAPID_PUBLIC_KEY so a
// rotated secret pair can override this value at /api/push/config.

export const VAPID_PUBLIC_KEY = 'BN6KuuiDYM3U8NUQVPdjVNrr6lSt-xOJIl6IvS-nUdAxAuMgOORfNr_UH0jYS-_5cj4BD_SKPyiJJVo0rPJ15Is';

export const IOS_PUSH_NOTE = 'On iPhone, notifications need Add to Home Screen and iOS 16.4 or newer. Safari in a browser tab cannot turn them on.';

export const PUSH_KINDS = [
  ['your_turn', 'Your turn'],
  ['direct_message', 'Direct message'],
  ['mention', 'Mention'],
  ['challenged', 'Challenge'],
  ['game_result', 'Game result'],
  ['challenge_accepted', 'Challenge accepted'],
  ['challenge_declined', 'Challenge declined'],
  ['market_offer', 'Marketplace trade offer'],
  ['market_accepted', 'Marketplace trade accepted'],
  ['market_declined', 'Marketplace trade declined'],
  ['market_order', 'Marketplace order'],
  ['market_shipped', 'Marketplace shipment']
];
