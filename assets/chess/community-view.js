import { LIMITS, cleanBody, cleanDiscussion, cleanEmail, cleanName, cleanReason, profilePath } from './community-model.js';
import { mentionParts } from './mentions.js';
import { mountPushPrompt, mountPushSettings } from './push-client.js';
import { prepareProfileImage } from './profile-picture.js';
import { authorChip, elementShown, forgetAuthorPortrait, markPortraitUnavailable, portraitFor } from './author-avatar.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function field(labelText, control) {
  const label = el('label', 'community-field');
  label.append(el('span', null, labelText), control);
  return label;
}

export function mountCommunity(root, options) {
  const gateway = options.gateway || null;
  let user = null;
  let profile = null;
  let posts = [];
  let cursor = null;
  let notice = '';
  let error = '';
  let pendingEmail = '';
  let busy = false;
  const authNotices = {
    browser: 'This sign-in link was opened without the browser session that requested it. Request a new link in that same browser.',
    expired: 'This sign-in link expired or was already used. Request a new one.',
    rejected: 'The sign-in provider did not complete the request. Request a new link in this browser.'
  };
  try {
    const params = new URL(window.location.href).searchParams;
    if (authNotices[params.get('auth')]) {
      notice = authNotices[params.get('auth')];
      params.delete('auth');
      window.history.replaceState({}, '', window.location.pathname + (params.toString() ? '?' + params.toString() : ''));
    }
  } catch (err) { /* the notice is optional */ }
  let phase = gateway && options.configured ? 'loading' : 'ready';
  const replies = new Map();
  const openReports = new Set();

  function setError(err) {
    error = err && err.message ? err.message : (err || '');
  }

  async function refreshSession() {
    if (!gateway) return;
    const session = await gateway.session();
    user = session && session.user ? session.user : null;
    profile = user ? await gateway.profile() : null;
  }

  async function loadFirst() {
    posts = [];
    cursor = null;
    replies.clear();
    if (!gateway || !profile) return;
    const page = await gateway.listPosts({ cursor: null, limit: LIMITS.pageSize });
    posts = page.posts;
    cursor = page.nextCursor;
  }

  async function run(action) {
    error = '';
    busy = true;
    render();
    try {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        throw new Error('You appear to be offline. Community posts are not stored on this device.');
      }
      await action();
    } catch (err) {
      setError(err);
    } finally {
      busy = false;
      render();
    }
  }

  function render() {
    root.replaceChildren();
    root.className = 'community';
    if (!options.configured) {
      root.append(
        el('p', 'eyebrow', 'Not configured'),
        el('p', null, 'Chess accounts could not be reached. This page does not sign in with a master account, and nothing is stored on this device.')
      );
      return;
    }
    if (phase === 'loading') {
      root.append(el('p', 'eyebrow', 'Checking sign-in'), el('p', null, 'Looking for a community session. No posts are stored on this device.'));
      return;
    }
    root.append(el('p', 'eyebrow', !user ? 'Not signed in' : profile ? 'Signed in' : 'Signed in. No Chess profile yet.'));
    if (notice) root.append(el('p', 'community-status', notice));
    if (error) {
      const alert = el('p', 'community-error', error);
      alert.setAttribute('role', 'alert');
      root.append(alert);
    }
    if (!user) signedOut();
    else if (!profile) nameForm();
    else feed();
    syncShellState();
  }

  function syncShellState() {
    const slot = document.getElementById('community-state');
    if (slot) {
      if (!options.configured) slot.textContent = 'Chess accounts could not be reached. Nothing is stored on this device.';
      else if (phase === 'loading') slot.textContent = 'Checking whether you are signed in.';
      else if (!user) slot.textContent = 'Not signed in. Join Chess is available only after you sign in.';
      else if (!profile) slot.textContent = 'Signed in. No Chess profile yet. Click Join Chess. No other service is joined.';
      else slot.textContent = 'Signed in as ' + profile.displayName + '.';
    }
    const own = document.getElementById('your-profile-slot');
    if (!own) return;
    own.replaceChildren();
    if (!profile) return;
    const link = document.createElement('a');
    link.className = 'entry';
    link.id = 'your-profile';
    link.href = profilePath(profile.id);
    const strong = document.createElement('strong');
    strong.textContent = 'Your profile';
    const span = document.createElement('span');
    span.textContent = 'Opens your Chess profile as its own page. Exit profile to return to the rest of the site.';
    link.append(strong, span);
    own.append(link);
    if (gateway) mountPushPrompt(own, gateway);
  }

  function signedOut() {
    const email = document.createElement('input');
    email.type = 'email';
    email.autocomplete = 'email';
    email.required = true;
    email.maxLength = 320;
    const name = document.createElement('input');
    name.type = 'text';
    name.maxLength = LIMITS.name;
    name.required = true;
    name.autocomplete = 'nickname';
    const button = el('button', 'tool', busy ? 'Sending…' : 'Email me a sign-in link');
    button.type = 'submit';
    button.disabled = busy;
    const google = el('button', 'tool', 'Continue with Google');
    google.type = 'button';
    google.addEventListener('click', () => run(async () => {
      await gateway.continueWithGoogle();
    }));
    const form = document.createElement('form');
    form.append(
      field('Email', email),
      field('Display name', name),
      button,
      google,
      el('p', 'community-note', 'This continues at the TWGI account service. Chess does not keep that login. Joining Chess is a separate step after you return, and it does not open any other service.')
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const emailResult = cleanEmail(email.value);
      const nameResult = cleanName(name.value);
      if (!emailResult.ok) { error = emailResult.error; render(); return; }
      if (!nameResult.ok) { error = nameResult.error; render(); return; }
      run(async () => {
        await gateway.signIn(emailResult.value, nameResult.value);
        pendingEmail = emailResult.value;
        notice = 'Check ' + pendingEmail + ' for the sign-in link. No Chess profile and no other service membership was created.';
      });
    });
    root.append(form);
  }

  function nameForm() {
    const name = document.createElement('input');
    name.type = 'text';
    name.maxLength = LIMITS.name;
    name.value = gateway.suggestedName ? gateway.suggestedName() : '';
    const button = el('button', 'tool', 'Join Chess');
    button.type = 'submit';
    const form = document.createElement('form');
    form.append(
      field('Display name', name),
      button,
      signOutButton(),
      el('p', 'community-note', 'Joining Chess creates your Chess profile only. It does not open other TWGI services.')
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const result = cleanName(name.value);
      if (!result.ok) { error = result.error; render(); return; }
      run(async () => {
        profile = await gateway.joinChess(result.value);
        notice = 'Chess profile saved. No other service was joined.';
        await loadFirst();
      });
    });
    root.append(form);
  }

  function signOutButton() {
    const button = el('button', 'tool', 'Sign out');
    button.type = 'button';
    button.addEventListener('click', () => run(async () => {
      await gateway.signOut();
      user = null;
      profile = null;
      posts = [];
      notice = '';
    }));
    return button;
  }

  function feed() {
    const heading = el('p', null, 'Signed in as ');
    const nameLink = document.createElement('a');
    nameLink.href = profilePath(profile.id);
    nameLink.textContent = profile.displayName;
    heading.append(nameLink, document.createTextNode('.'));
    const rename = document.createElement('input');
    rename.type = 'text';
    rename.maxLength = LIMITS.name;
    rename.value = profile.displayName;
    const renameButton = el('button', 'tool', 'Rename');
    renameButton.type = 'button';
    renameButton.addEventListener('click', () => {
      const result = cleanName(rename.value);
      if (!result.ok) { error = result.error; render(); return; }
      const editingId = profile.id;
      run(async () => {
        const session = await gateway.profile();
        if (!session || session.id !== editingId) throw new Error('You can edit only your own Chess profile.');
        const saved = await gateway.renameProfile(result.value, editingId);
        if (!saved || saved.id !== editingId) throw new Error('You can edit only your own Chess profile.');
        profile = Object.assign({}, profile, { displayName: saved.displayName });
      });
    });
    const tools = el('div', 'community-tools');
    tools.append(rename, renameButton, signOutButton());

    const body = document.createElement('textarea');
    body.maxLength = LIMITS.body;
    body.rows = 4;
    const counter = el('p', 'community-note', '0 / ' + LIMITS.body);
    body.addEventListener('input', () => { counter.textContent = body.value.length + ' / ' + LIMITS.body; });
    const postButton = el('button', 'tool', 'Post');
    postButton.type = 'submit';
    const form = document.createElement('form');
    form.append(field('New post', body), counter, postButton);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const result = cleanBody(body.value);
      if (!result.ok) { error = result.error; render(); return; }
      run(async () => {
        await gateway.createPost(result.value);
        notice = '';
        await loadFirst();
      });
    });

    const list = el('div', 'community-list');
    if (!posts.length) list.append(el('p', null, 'No posts yet.'));
    posts.forEach((post) => list.append(postArticle(post)));
    if (cursor) {
      const more = el('button', 'tool', 'Older posts');
      more.type = 'button';
      more.addEventListener('click', () => run(async () => {
        const page = await gateway.listPosts({ cursor, limit: LIMITS.pageSize });
        posts = posts.concat(page.posts);
        cursor = page.nextCursor;
      }));
      list.append(more);
    }
    root.append(heading, tools, form, list);
  }

  function postArticle(post) {
    const article = el('article', 'community-post');
    const title = el('h3');
    title.append(authorChip(post.authorName, post.authorId));
    article.append(title, el('p', 'community-time', post.createdAt), textBlock(post.body));
    if (post.hidden) article.append(el('p', 'community-note', 'Hidden from other members.'));
    const bar = el('div', 'community-tools');
    if (profile && post.authorId === profile.id) bar.append(deleteButton('Delete post', () => gateway.deletePost(post.id).then(loadFirst)));
    else bar.append(reportControl(post.id, null));
    article.append(bar);
    const thread = replies.get(post.id) || { items: [], cursor: null, loaded: false };
    thread.items.forEach((reply) => article.append(replyArticle(reply)));
    if (!thread.loaded) {
      const load = el('button', 'tool', 'Show replies');
      load.type = 'button';
      load.addEventListener('click', () => run(async () => {
        const page = await gateway.listReplies(post.id, { cursor: null, limit: LIMITS.pageSize });
        replies.set(post.id, { items: page.replies, cursor: page.nextCursor, loaded: true });
      }));
      article.append(load);
    } else if (thread.cursor) {
      const more = el('button', 'tool', 'More replies');
      more.type = 'button';
      more.addEventListener('click', () => run(async () => {
        const page = await gateway.listReplies(post.id, { cursor: thread.cursor, limit: LIMITS.pageSize });
        thread.items = thread.items.concat(page.replies);
        thread.cursor = page.nextCursor;
      }));
      article.append(more);
    }
    article.append(replyForm(post.id));
    return article;
  }

  function replyArticle(reply) {
    const block = el('div', 'community-reply');
    const title = el('h4');
    title.append(authorChip(reply.authorName, reply.authorId));
    block.append(title, el('p', 'community-time', reply.createdAt), textBlock(reply.body));
    if (reply.hidden) block.append(el('p', 'community-note', 'Hidden from other members.'));
    if (profile && reply.authorId === profile.id) {
      block.append(deleteButton('Delete reply', () => gateway.deleteReply(reply.id).then(async () => {
        const page = await gateway.listReplies(reply.postId, { cursor: null, limit: LIMITS.pageSize });
        replies.set(reply.postId, { items: page.replies, cursor: page.nextCursor, loaded: true });
      })));
    } else block.append(reportControl(null, reply.id));
    return block;
  }

  function replyForm(postId) {
    const body = document.createElement('textarea');
    body.maxLength = LIMITS.body;
    body.rows = 2;
    const button = el('button', 'tool', 'Reply');
    button.type = 'submit';
    const form = document.createElement('form');
    form.append(field('Reply', body), button);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const result = cleanBody(body.value);
      if (!result.ok) { error = result.error; render(); return; }
      run(async () => {
        await gateway.createReply(postId, result.value);
        const page = await gateway.listReplies(postId, { cursor: null, limit: LIMITS.pageSize });
        replies.set(postId, { items: page.replies, cursor: page.nextCursor, loaded: true });
      });
    });
    return form;
  }

  function textBlock(value) {
    const paragraph = el('p', 'community-body');
    paragraph.textContent = value;
    return paragraph;
  }

  function deleteButton(label, action) {
    const button = el('button', 'tool', label);
    button.type = 'button';
    button.addEventListener('click', () => run(action));
    return button;
  }

  function reportControl(postId, replyId) {
    const key = postId || replyId;
    const wrap = el('div', 'community-tools');
    if (!openReports.has(key)) {
      const button = el('button', 'tool', 'Report');
      button.type = 'button';
      button.addEventListener('click', () => { openReports.add(key); render(); });
      wrap.append(button);
      return wrap;
    }
    const reason = document.createElement('input');
    reason.type = 'text';
    reason.maxLength = LIMITS.reason;
    const send = el('button', 'tool', 'Send report');
    send.type = 'button';
    send.addEventListener('click', () => {
      const result = cleanReason(reason.value);
      if (!result.ok) { error = result.error; render(); return; }
      run(async () => {
        await gateway.report({ postId, replyId, reason: result.value });
        openReports.delete(key);
        notice = 'Report saved for community admins. Other members cannot read it.';
      });
    });
    wrap.append(reason, send);
    return wrap;
  }

  if (gateway && options.configured) {
    gateway.onAuth(() => {
      run(async () => {
        await refreshSession();
        phase = 'ready';
        if (profile) await loadFirst();
      });
    });
    window.addEventListener('chess-session', () => {
      run(async () => {
        await refreshSession();
        phase = 'ready';
        if (profile) await loadFirst();
        else posts = [];
      });
    });
    run(async () => {
      await refreshSession();
      phase = 'ready';
      if (profile) await loadFirst();
    });
  } else render();

  return { render };
}

export function mountDiscussion(root, options) {
  const gateway = options.gateway || null;
  let profile = null;
  let messages = [];
  let error = '';
  let notice = '';
  let oldest = null;
  let timer = 0;
  let shell = null;
  let inputNode = null;
  let draftText = '';
  let draftAuthorId = null;
  let draining = false;
  let pollCursor = null;
  let initialSync = null;
  const seen = new Set();
  const pageSize = 20;

  function laterCursor(left, right) {
    const time = String(left.createdAt).localeCompare(String(right.createdAt));
    if (time) return time > 0 ? left : right;
    return String(left.id).localeCompare(String(right.id)) > 0 ? left : right;
  }

  function advancePollCursor(pageMessages) {
    if (!pageMessages || !pageMessages.length) return;
    let newest = pageMessages[0];
    for (const item of pageMessages) newest = laterCursor(newest, item);
    const next = { createdAt: newest.createdAt, id: newest.id };
    if (!pollCursor || (laterCursor(next, pollCursor) === next && next.id !== pollCursor.id)) pollCursor = next;
  }

  function remember(items) {
    items.forEach((item) => {
      if (!item || seen.has(item.id)) return;
      seen.add(item.id);
      messages.push(item);
    });
    messages.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
    oldest = messages[0] || null;
  }

  function paintStatus() {
    if (!shell) return;
    shell.error.hidden = !error;
    shell.error.textContent = error;
    shell.notice.hidden = !notice;
    shell.notice.textContent = notice;
  }

  function paintMessages() {
    if (!shell) return;
    shell.earlier.hidden = !oldest;
    shell.log.replaceChildren();
    if (!messages.length) {
      shell.log.append(el('p', null, 'No messages yet.'));
      return;
    }
    messages.forEach((item) => {
      const line = el('p', 'discussion-line');
      const body = document.createElement('span');
      body.className = 'discussion-body';
      body.append(document.createTextNode(' '));
      mentionParts(item.body, item.mentions).forEach((part) => {
        if (part.type === 'link') {
          const link = document.createElement('a');
          link.href = part.href;
          link.textContent = part.text;
          body.append(link);
          return;
        }
        body.append(document.createTextNode(part.text));
      });
      line.append(authorChip(item.authorName || 'Member', item.authorId), body);
      shell.log.append(line);
    });
  }

  function discardDraft(message) {
    draftText = '';
    draftAuthorId = null;
    if (inputNode) inputNode.value = '';
    if (message) notice = message;
  }

  function paintComposer() {
    if (!shell) return;
    if (!profile) {
      if (inputNode) {
        draftText = inputNode.value;
        inputNode = null;
      }
      shell.composer.replaceChildren(el('p', 'community-note', 'Sign in and click Join Chess before writing in the discussion.'));
      return;
    }
    if (draftAuthorId && profile.id !== draftAuthorId) {
      discardDraft('That draft was discarded because the Chess profile changed.');
      paintStatus();
    }
    if (inputNode && inputNode.parentNode) return;
    const input = document.createElement('textarea');
    input.id = 'discussion-body';
    input.maxLength = 1000;
    input.rows = 3;
    input.value = draftText;
    input.addEventListener('input', () => {
      draftText = input.value;
      draftAuthorId = input.value ? profile.id : null;
    });
    const send = el('button', 'tool', 'Send');
    send.id = 'discussion-send';
    send.type = 'button';
    send.addEventListener('click', () => submit());
    inputNode = input;
    shell.composer.replaceChildren(field('Message', input), send);
  }

  function render() {
    if (!options.configured) {
      root.replaceChildren();
      root.className = 'community';
      root.append(el('p', null, 'The discussion could not be reached. Nothing from it is stored on this device.'));
      return;
    }
    if (!shell) {
      root.replaceChildren();
      root.className = 'community';
      const back = document.createElement('a');
      back.href = '/community/';
      back.textContent = 'Community';
      const errorNode = el('p', 'community-error', '');
      errorNode.setAttribute('role', 'alert');
      const noticeNode = el('p', 'community-status', '');
      const earlier = el('button', 'tool', 'Earlier messages');
      earlier.type = 'button';
      earlier.addEventListener('click', () => loadOlder());
      const log = el('div', 'discussion-log');
      log.id = 'discussion-log';
      const composer = el('div', null, '');
      shell = { error: errorNode, notice: noticeNode, earlier, log, composer };
      root.append(
        back,
        el('h2', null, 'Discussion'),
        el('p', 'community-note', 'One conversation for everyone who has joined Chess. Messages are kept by the Chess account service, not on this device. New messages are checked every few seconds.'),
        errorNode,
        noticeNode,
        earlier,
        log,
        composer
      );
    }
    paintStatus();
    paintMessages();
    paintComposer();
  }

  async function submit() {
    if (!inputNode) return;
    const result = cleanDiscussion(inputNode.value);
    if (!result.ok) { error = result.error; paintStatus(); return; }
    const authorAtSend = draftAuthorId || (profile && profile.id);
    error = '';
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      error = 'The discussion is not stored on this device.';
      paintStatus();
      return;
    }
    try {
      const session = await gateway.profile();
      if (!session || !authorAtSend || session.id !== authorAtSend) {
        profile = session;
        discardDraft();
        error = 'This draft belongs to a different Chess profile. It was not sent.';
        paintComposer();
        paintStatus();
        return;
      }
      profile = session;
      const message = await gateway.sendDiscussion(result.value, authorAtSend);
      remember([message]);
      discardDraft();
      notice = '';
      paintMessages();
    } catch (err) {
      error = err && err.message ? err.message : 'The discussion is not stored on this device.';
    }
    paintStatus();
  }

  async function loadOlder() {
    if (!oldest) return;
    try {
      const page = await gateway.listDiscussion({ before: { createdAt: oldest.createdAt, id: oldest.id }, limit: pageSize });
      if (!page.messages.length) notice = 'No earlier messages.';
      remember(page.messages);
    } catch (err) {
      error = err && err.message ? err.message : 'The discussion could not be loaded.';
    }
    paintMessages();
    paintStatus();
  }

  function startInitial() {
    if (initialSync) return initialSync;
    initialSync = gateway.listDiscussion({ limit: pageSize }).then((page) => {
      const rows = page.messages || [];
      remember(rows);
      advancePollCursor(rows);
      paintMessages();
      return page;
    }).catch((err) => {
      initialSync = null;
      error = err && err.message ? err.message : 'The discussion could not be loaded.';
      paintStatus();
      throw err;
    });
    return initialSync;
  }

  async function loadNew() {
    if (draining || document.hidden || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
    draining = true;
    try {
      await startInitial();
      let pages = 0;
      while (pages < 5) {
        const page = await gateway.listDiscussion(pollCursor
          ? { after: { createdAt: pollCursor.createdAt, id: pollCursor.id }, limit: pageSize }
          : { limit: pageSize });
        pages += 1;
        const rows = page.messages || [];
        if (!rows.length) break;
        const beforeCount = messages.length;
        remember(rows);
        advancePollCursor(rows);
        if (messages.length !== beforeCount) {
          paintMessages();
          paintStatus();
        }
        if (rows.length < pageSize) break;
      }
    } catch (err) { /* the next check tries again */ }
    finally { draining = false; }
  }

  render();
  if (!options.configured || !gateway) return;
  gateway.profile().then((person) => { profile = person; paintComposer(); }).catch(() => { profile = null; paintComposer(); });
  startInitial();
  timer = window.setInterval(loadNew, 4000);
  window.addEventListener('pagehide', () => window.clearInterval(timer));
}

export function mountProfile(root, options) {
  const gateway = options.gateway || null;
  let phase = options.configured && options.valid ? 'loading' : 'ready';
  let error = '';
  let person = null;
  let viewer = null;
  let posts = [];
  let cursor = null;
  let imageVersion = 1;
  let attempts = null;
  let attemptCursor = null;
  let openAttempt = null;

  function puzzleChange(item) {
    if (item.summoned) return 'Unrated (summoned)';
    if (item.status === 'abandoned') return 'Unrated';
    if (item.status === 'solved') {
      const bonus = Number(item.bonus) || 0;
      const gain = Number(item.delta) - bonus;
      return bonus ? '+' + gain + ' +' + bonus + ' streak' : '+' + gain;
    }
    const delta = Number(item.delta) || 0;
    return delta > 0 ? '+' + delta : String(delta);
  }

  function puzzleStatus(status) {
    if (status === 'solved') return 'Solved';
    if (status === 'failed') return 'Failed';
    return 'Abandoned';
  }

  function renderPuzzleHistory() {
    const section = el('section', 'puzzle-history');
    section.append(el('h2', null, 'Puzzle attempts'));
    if (!attempts.length) section.append(el('p', null, 'No puzzle attempts yet.'));
    attempts.forEach((item) => {
      const block = el('article', 'puzzle-attempt');
      const button = el('button', 'tool', (item.serial ? '#' + item.serial + ' · ' : '') + 'Puzzle ' + item.puzzleId + ' · ' + item.puzzleRating + ' · ' + (item.summoned ? 'Unrated (summoned)' : puzzleStatus(item.status)) + ' · ' + puzzleChange(item) + ' · streak ' + item.streakBefore);
      button.type = 'button';
      button.addEventListener('click', () => {
        if (openAttempt && openAttempt.attemptId === item.id) {
          openAttempt = null;
          render();
          return;
        }
        load(async () => { openAttempt = await gateway.puzzleAttempt(item.id); });
      });
      block.append(button);
      if (item.serial) {
        const open = document.createElement('a');
        open.className = 'tool';
        open.href = '/puzzles/?serial=' + encodeURIComponent(item.serial);
        open.textContent = 'Open #' + item.serial;
        block.append(open);
      }
      if (openAttempt && openAttempt.attemptId === item.id) {
        (openAttempt.played || []).forEach((move) => {
          const seconds = ((Number(move.millis) || 0) / 1000).toFixed(1);
          block.append(el('p', null, 'Move ' + move.ply + ' ' + move.uci + (move.correct ? '' : ' incorrect') + ' · ' + seconds + 's'));
        });
        const solution = openAttempt.solutionSans || openAttempt.solution || [];
        block.append(el('p', null, 'Solution ' + solution.join(' ')));
      }
      section.append(block);
    });
    if (attemptCursor) {
      const more = el('button', 'tool', 'Older attempts');
      more.type = 'button';
      more.id = 'older-attempts';
      more.addEventListener('click', () => load(async () => {
        const page = await gateway.puzzleAttempts(attemptCursor);
        attempts = attempts.concat(page.attempts);
        attemptCursor = page.next;
      }));
      section.append(more);
    }
    root.append(section);
  }

  async function saveImage(kind, file) {
    const editingId = person.id;
    if (!file) throw new Error('Choose a JPEG, PNG, or WebP image.');
    const prepared = await prepareProfileImage(file);
    const session = await gateway.profile();
    if (!session || session.id !== editingId) throw new Error('You can edit only your own Chess profile.');
    await gateway.saveProfileImage(kind, prepared.bytes, prepared.type, editingId);
    if (kind === 'portrait') {
      person.hasPortrait = true;
      forgetAuthorPortrait(person.id);
    } else person.hasBackground = true;
    imageVersion += 1;
  }

  function render() {
    root.replaceChildren();
    root.className = 'community';
    if (!options.configured) {
      root.append(
        el('p', 'eyebrow', 'Not configured'),
        el('p', null, 'Chess accounts could not be reached. This page does not sign in with a master account, and no member is shown.')
      );
      return;
    }
    if (!options.valid) {
      root.append(
        el('p', 'eyebrow', 'Profile'),
        el('p', 'community-error', options.reason === 'missing'
          ? 'This address does not name a member.'
          : 'That profile address is not valid.')
      );
      return;
    }
    if (phase === 'loading') {
      root.append(el('p', 'eyebrow', 'Loading profile'), el('p', null, 'Loading this profile. No posts are stored on this device.'));
      return;
    }
    if (error) {
      const alert = el('p', 'community-error', error);
      alert.setAttribute('role', 'alert');
      root.append(alert);
    }
    if (!person) {
      root.append(el('p', 'eyebrow', 'Profile'), el('p', null, 'No community profile uses this address.'));
      return;
    }
    const banner = el('div', 'profile-banner' + (person.hasBackground ? '' : ' is-empty'));
    if (person.hasBackground) {
      banner.style.backgroundImage = 'url("/api/profiles/' + encodeURIComponent(person.id) + '/background?v=' + imageVersion + '")';
    } else {
      banner.append(el('p', 'profile-empty', 'No background image yet'));
    }
    const portrait = el('div', 'profile-portrait');
    if (person.hasPortrait) {
      const img = document.createElement('img');
      img.alt = person.displayName;
      portrait.append(img);
      portraitFor(person.id).then((result) => {
        if (!elementShown(img) || !result || result.status === 'stale') return;
        if (result.status === 'image' && result.url) {
          img.addEventListener('error', () => {
            markPortraitUnavailable(person.id, result.url);
            if (!elementShown(portrait)) return;
            portrait.replaceChildren(el('p', 'profile-empty', 'Profile picture unavailable'));
          });
          img.src = result.url;
          return;
        }
        portrait.replaceChildren(el('p', 'profile-empty', result.status === 'absent' ? 'No profile picture yet' : 'Profile picture unavailable'));
      });
    } else {
      portrait.append(el('p', 'profile-empty', 'No profile picture yet'));
    }
    banner.append(portrait);
    const bio = el('p', 'profile-bio');
    bio.textContent = person.bio ? person.bio : 'No bio yet.';
    root.append(banner, el('h2', null, person.displayName), bio);
    const ratings = el('div', 'profile-ratings');
    [['bullet', 'Bullet'], ['blitz', 'Blitz'], ['rapid', 'Rapid'], ['daily', 'Daily'], ['untimed', 'Untimed'], ['puzzles', 'Puzzles']].forEach(([key, label]) => {
      const value = person.ratings ? person.ratings[key] : null;
      const shown = key === 'puzzles' ? (value == null ? 'Unrated' : String(value)) : String(value == null ? 0 : value);
      ratings.append(el('p', null, label + ' ' + shown));
    });
    root.append(ratings);
    if (viewer && viewer.id !== person.id) {
      const message = document.createElement('a');
      message.className = 'tool';
      message.href = '/community/messages/?with=' + encodeURIComponent(person.id);
      message.textContent = 'Message';
      const challenge = document.createElement('a');
      challenge.className = 'tool';
      challenge.href = '/human/?opponent=' + encodeURIComponent(person.id);
      challenge.textContent = 'Challenge to a game';
      root.append(message, challenge);
    }
    root.append(el('p', 'community-note', 'This is a Chess community profile. It does not show an email address or any other service.'));
    if (person.createdAt) root.append(el('p', 'community-time', 'Profile created ' + person.createdAt));
    if (attempts) renderPuzzleHistory();
    if (viewer && viewer.id === person.id) {
      const name = document.createElement('input');
      name.type = 'text';
      name.maxLength = LIMITS.name;
      name.value = person.displayName;
      const button = el('button', 'tool', 'Save display name');
      button.type = 'button';
      button.addEventListener('click', () => {
        const result = cleanName(name.value);
        if (!result.ok) { error = result.error; render(); return; }
        const editingId = person.id;
        load(async () => {
          const session = await gateway.profile();
          if (!session || session.id !== editingId) throw new Error('You can edit only your own Chess profile.');
          const saved = await gateway.renameProfile(result.value, editingId);
          if (!saved || saved.id !== editingId) throw new Error('You can edit only your own Chess profile.');
          person = Object.assign({}, person, { displayName: saved.displayName });
        });
      });
      const bioInput = document.createElement('textarea');
      bioInput.maxLength = 280;
      bioInput.rows = 3;
      bioInput.value = person.bio || '';
      const saveBio = el('button', 'tool', 'Save bio');
      saveBio.type = 'button';
      saveBio.addEventListener('click', () => load(async () => {
        const editingId = person.id;
        const session = await gateway.profile();
        if (!session || session.id !== editingId) throw new Error('You can edit only your own Chess profile.');
        const next = String(bioInput.value || '').replace(/\r\n/g, '\n').trim();
        if (next.length > 280) throw new Error('A bio can be at most 280 characters.');
        const saved = await gateway.saveProfileBio(next, editingId);
        person = saved;
      }));
      const portraitInput = document.createElement('input');
      portraitInput.type = 'file';
      portraitInput.accept = 'image/jpeg,image/png,image/webp';
      portraitInput.id = 'portrait-file';
      const backgroundInput = document.createElement('input');
      backgroundInput.type = 'file';
      backgroundInput.accept = 'image/jpeg,image/png,image/webp';
      backgroundInput.id = 'background-file';
      const savePortrait = el('button', 'tool', 'Save profile picture');
      savePortrait.type = 'button';
      savePortrait.addEventListener('click', () => {
        const file = portraitInput.files && portraitInput.files[0];
        load(() => saveImage('portrait', file));
      });
      const saveBackground = el('button', 'tool', 'Save background image');
      saveBackground.type = 'button';
      saveBackground.addEventListener('click', () => {
        const file = backgroundInput.files && backgroundInput.files[0];
        load(() => saveImage('background', file));
      });
      const tools = el('div', 'community-tools');
      tools.append(name, button, field('Bio', bioInput), saveBio, field('Profile picture', portraitInput), savePortrait, field('Background image', backgroundInput), saveBackground);
      root.append(tools);
      if (gateway) mountPushSettings(root, gateway);
    }
    const list = el('div', 'community-list');
    list.append(el('h3', null, 'Posts'));
    if (!posts.length) list.append(el('p', null, 'No public posts yet.'));
    posts.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(b.id).localeCompare(String(a.id)));
    posts.forEach((post) => {
      const article = el('article', 'community-post');
      const title = el('h3');
      title.append(authorChip(post.authorName, post.authorId));
      article.append(title, el('p', 'community-time', post.createdAt));
      const body = el('p', 'community-body');
      body.textContent = post.body;
      article.append(body);
      list.append(article);
    });
    if (cursor) {
      const more = el('button', 'tool', 'Older posts');
      more.type = 'button';
      more.addEventListener('click', () => load(async () => {
        const page = await gateway.listAuthorPosts(person.id, { cursor, limit: LIMITS.pageSize });
        posts = posts.concat(page.posts);
        cursor = page.nextCursor;
      }));
      list.append(more);
    }
    root.append(list);
  }

  async function load(action) {
    error = '';
    render();
    try {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        throw new Error('You appear to be offline. Community posts are not stored on this device.');
      }
      await action();
    } catch (err) {
      error = err && err.message ? err.message : 'The profile could not be loaded.';
    }
    phase = 'ready';
    render();
  }

  if (!options.configured || !options.valid) {
    render();
    return;
  }
  load(async () => {
    const session = await gateway.session();
    viewer = await gateway.profile();
    person = await gateway.getPublicProfile(options.profileId);
    if (!person) return;
    const page = await gateway.listAuthorPosts(person.id, { cursor: null, limit: LIMITS.pageSize });
    posts = page.posts;
    cursor = page.nextCursor;
    if (viewer && person && viewer.id === person.id && gateway && gateway.puzzleAttempts) {
      try {
        const history = await gateway.puzzleAttempts(null);
        attempts = history.attempts;
        attemptCursor = history.next;
      } catch (err) {
        attempts = null;
      }
    }
  });
}

export function mountMessages(root, options) {
  const gateway = options.gateway || null;
  let profile = null;
  let threads = [];
  let open = null;
  let error = '';
  let draft = '';

  function paintThread(parent) {
    if (!open) return;
    const title = el('h2', null, open.with && open.with.displayName ? open.with.displayName : 'Conversation');
    const log = el('div', 'discussion-log');
    log.id = 'message-log';
    (open.messages || []).forEach((item) => {
      const line = el('p', 'discussion-line');
      line.append(el('span', 'discussion-body', item.body));
      log.append(line);
    });
    const input = document.createElement('textarea');
    input.id = 'message-body';
    input.maxLength = 1000;
    input.rows = 3;
    input.value = draft;
    input.addEventListener('input', () => { draft = input.value; });
    const send = el('button', 'tool', 'Send');
    send.type = 'button';
    send.id = 'message-send';
    send.addEventListener('click', () => { void submit(); });
    parent.append(title, log, field('Message', input), send);
  }

  function render() {
    root.replaceChildren();
    root.className = 'community';
    if (!options.configured) {
      root.append(el('p', null, 'Messages could not be reached. Nothing from them is stored on this device.'));
      return;
    }
    const back = document.createElement('a');
    back.href = '/community/';
    back.textContent = 'Community';
    root.append(back, el('h2', null, 'Messages'));
    if (error) root.append(el('p', 'community-error', error));
    if (!profile) {
      root.append(el('p', 'community-note', 'Sign in and click Join Chess before reading messages.'));
      return;
    }
    if (!open) {
      if (!threads.length) root.append(el('p', null, 'No messages yet.'));
      threads.forEach((thread) => {
        const link = document.createElement('a');
        link.className = 'entry';
        link.href = '/community/messages/?with=' + encodeURIComponent(thread.with.id);
        link.append(el('strong', null, thread.with.displayName || 'Member'), el('span', null, thread.body || ''));
        root.append(link);
      });
      return;
    }
    paintThread(root);
  }

  async function submit() {
    const result = cleanDiscussion(draft);
    if (!result.ok) { error = result.error; render(); return; }
    try {
      const sent = await gateway.sendMessage(open.with.id, result.value, profile.id);
      open.messages = (open.messages || []).concat([sent]);
      draft = '';
      error = '';
    } catch (err) {
      error = err && err.message ? err.message : 'The message could not be sent.';
    }
    render();
  }

  render();
  if (!options.configured || !gateway) return;
  gateway.profile().then(async (session) => {
    profile = session;
    if (!profile) { render(); return; }
    if (options.withId) open = await gateway.openMessages(options.withId);
    else {
      const inbox = await gateway.listMessages();
      threads = inbox.threads || [];
    }
    render();
  }).catch((err) => {
    error = err && err.message ? err.message : 'Messages could not be loaded.';
    render();
  });
}
