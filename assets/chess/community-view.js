import { LIMITS, cleanBody, cleanEmail, cleanName, cleanReason, profilePath } from './community-model.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function authorLink(name, id) {
  const link = document.createElement('a');
  link.href = profilePath(id);
  link.textContent = name;
  return link;
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
        el('p', null, 'Shared posts need the Chess database migration and a publishable key. No posts are shown, and nothing is stored on this device.')
      );
      return;
    }
    if (phase === 'loading') {
      root.append(el('p', 'eyebrow', 'Checking sign-in'), el('p', null, 'Looking for a community session. No posts are stored on this device.'));
      return;
    }
    root.append(el('p', 'eyebrow', profile ? 'Signed in' : 'Sign in required'));
    if (notice) root.append(el('p', 'community-status', notice));
    if (error) {
      const alert = el('p', 'community-error', error);
      alert.setAttribute('role', 'alert');
      root.append(alert);
    }
    if (!user) signedOut();
    else if (!profile) nameForm();
    else feed();
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
    const form = document.createElement('form');
    form.append(
      field('Email', email),
      field('Display name', name),
      button,
      el('p', 'community-note', 'The link only verifies this email. It does not join Chess or any other TWGI service. Joining Chess is a separate step after you return.')
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
        profile = await gateway.saveProfile(result.value);
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
    const heading = el('p', null, 'Signed in as ' + profile.displayName + '.');
    const ownProfile = document.createElement('a');
    ownProfile.href = profilePath(profile.id);
    ownProfile.textContent = 'Your profile';
    heading.append(document.createTextNode(' '), ownProfile);
    const rename = document.createElement('input');
    rename.type = 'text';
    rename.maxLength = LIMITS.name;
    rename.value = profile.displayName;
    const renameButton = el('button', 'tool', 'Rename');
    renameButton.type = 'button';
    renameButton.addEventListener('click', () => {
      const result = cleanName(rename.value);
      if (!result.ok) { error = result.error; render(); return; }
      run(async () => {
        profile = await gateway.saveProfile(result.value);
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
    title.append(authorLink(post.authorName, post.authorId));
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
    title.append(authorLink(reply.authorName, reply.authorId));
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
    run(async () => {
      await refreshSession();
      phase = 'ready';
      if (profile) await loadFirst();
    });
  } else render();

  return { render };
}

export function mountProfile(root, options) {
  const gateway = options.gateway || null;
  let phase = options.configured && options.valid ? 'loading' : 'ready';
  let error = '';
  let person = null;
  let viewer = null;
  let posts = [];
  let cursor = null;

  function render() {
    root.replaceChildren();
    root.className = 'community';
    const back = document.createElement('a');
    back.href = '/community/';
    back.textContent = 'Community';
    root.append(back);
    if (!options.configured) {
      root.append(
        el('p', 'eyebrow', 'Not configured'),
        el('p', null, 'Profile pages need the Chess database migration and a publishable key. No member is shown, and nothing is stored on this device.')
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
    root.append(el('h2', null, person.displayName));
    if (person.createdAt) root.append(el('p', 'community-time', 'Profile created ' + person.createdAt));
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
        load(async () => {
          const saved = await gateway.saveProfile(result.value);
          person = { id: saved.id, displayName: saved.displayName, createdAt: person.createdAt };
        });
      });
      const tools = el('div', 'community-tools');
      tools.append(name, button);
      root.append(tools);
    }
    const list = el('div', 'community-list');
    if (!posts.length) list.append(el('p', null, 'No public posts yet.'));
    posts.forEach((post) => {
      const article = el('article', 'community-post');
      const title = el('h3');
      title.append(authorLink(post.authorName, post.authorId));
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
  });
}
