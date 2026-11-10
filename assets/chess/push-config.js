// Public VAPID key for chess.theworldgovernmentincorporated.com.
// The matching private key is a Worker secret named VAPID_PRIVATE_KEY.
// It is not in this repository. The Worker also reads VAPID_PUBLIC_KEY so a
// rotated secret pair can override this value at /api/push/config.

export const VAPID_PUBLIC_KEY = 'BE3sCe7xrSSSUW1QMpfrkJN2oOXv8IS170R-5WKHaj-_055W77uPHKa4fFJkc9cFyfQ9Iyp5BNT8N3CXQAcFWRw';

export const IOS_PUSH_NOTE = 'On iPhone, notifications need Add to Home Screen and iOS 16.4 or newer. Safari in a browser tab cannot turn them on.';

export const PUSH_KINDS = [
  ['your_turn', 'Your turn'],
  ['direct_message', 'Direct message'],
  ['mention', 'Mention'],
  ['challenged', 'Challenge'],
  ['game_result', 'Game result'],
  ['challenge_accepted', 'Challenge accepted'],
  ['challenge_declined', 'Challenge declined']
];
