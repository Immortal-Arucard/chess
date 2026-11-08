import { feedFilter, nextCursor } from './community-model.js';

const POST_COLUMNS = 'id,author_id,body,created_at,hidden_at,chess_profiles(display_name)';
const REPLY_COLUMNS = 'id,post_id,author_id,body,created_at,hidden_at,chess_profiles(display_name)';
const PENDING_NAME = 'chess.pendingDisplayName';

function failed(error) {
  const message = (error && error.message) || 'The community request failed.';
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return new Error('You appear to be offline. Community posts are not stored on this device.');
  }
  if (/failed to fetch|network|offline|load failed|timeout/i.test(message)) {
    return new Error('You appear to be offline. Community posts are not stored on this device.');
  }
  return new Error(message);
}

function shapePost(row) {
  const profile = Array.isArray(row.chess_profiles) ? row.chess_profiles[0] : row.chess_profiles;
  return {
    id: row.id,
    authorId: row.author_id,
    authorName: (profile && profile.display_name) || 'Member',
    body: row.body,
    createdAt: row.created_at,
    hidden: !!row.hidden_at
  };
}

export function createSupabaseGateway(client) {
  let listener = () => {};
  return {
    suggestedName() {
      try { return sessionStorage.getItem(PENDING_NAME) || ''; } catch (err) { return ''; }
    },
    onAuth(fn) { listener = fn; },
    async session() {
      const result = await client.auth.getSession();
      if (result.error) throw failed(result.error);
      return result.data.session;
    },
    async signIn(email, displayName) {
      try { sessionStorage.setItem(PENDING_NAME, displayName); } catch (err) { /* the name form asks again */ }
      const result = await client.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: location.origin + '/community/',
          shouldCreateUser: true
        }
      });
      if (result.error) throw failed(result.error);
    },
    async signOut() {
      const result = await client.auth.signOut();
      if (result.error) throw failed(result.error);
      try { sessionStorage.removeItem(PENDING_NAME); } catch (err) { /* ignore */ }
    },
    async profile() {
      const session = await this.session();
      if (!session) return null;
      const result = await client.from('chess_profiles').select('id,display_name').eq('id', session.user.id).maybeSingle();
      if (result.error) throw failed(result.error);
      if (!result.data) return null;
      return { id: result.data.id, displayName: result.data.display_name };
    },
    async saveProfile(displayName) {
      const session = await this.session();
      if (!session) throw new Error('Sign in before choosing a display name.');
      const existing = await this.profile();
      const write = existing
        ? client.from('chess_profiles').update({ display_name: displayName }).eq('id', session.user.id).select('id,display_name').single()
        : client.from('chess_profiles').insert({ id: session.user.id, display_name: displayName }).select('id,display_name').single();
      const result = await write;
      if (result.error) throw failed(result.error);
      try { sessionStorage.removeItem(PENDING_NAME); } catch (err) { /* ignore */ }
      return { id: result.data.id, displayName: result.data.display_name };
    },
    async getPublicProfile(id) {
      const result = await client.from('chess_profiles').select('id,display_name,created_at').eq('id', id).maybeSingle();
      if (result.error) throw failed(result.error);
      if (!result.data) return null;
      return { id: result.data.id, displayName: result.data.display_name, createdAt: result.data.created_at };
    },
    async listAuthorPosts(authorId, { cursor, limit }) {
      let query = client.from('chess_posts').select(POST_COLUMNS).eq('author_id', authorId).is('hidden_at', null).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit);
      const filter = feedFilter(cursor);
      if (filter) query = query.or(filter);
      const result = await query;
      if (result.error) throw failed(result.error);
      const posts = (result.data || []).map(shapePost);
      return { posts, nextCursor: nextCursor(posts, limit) };
    },
    async listPosts({ cursor, limit }) {
      let query = client.from('chess_posts').select(POST_COLUMNS).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit);
      const filter = feedFilter(cursor);
      if (filter) query = query.or(filter);
      const result = await query;
      if (result.error) throw failed(result.error);
      const posts = (result.data || []).map(shapePost);
      return { posts, nextCursor: nextCursor(posts, limit) };
    },
    async createPost(body) {
      const session = await this.session();
      if (!session) throw new Error('Sign in before posting.');
      const result = await client.from('chess_posts').insert({ author_id: session.user.id, body }).select('id').single();
      if (result.error) throw failed(result.error);
    },
    async listReplies(postId, { cursor, limit }) {
      let query = client.from('chess_replies').select(REPLY_COLUMNS).eq('post_id', postId).order('created_at', { ascending: true }).order('id', { ascending: true }).limit(limit);
      if (cursor) query = query.or(`and(created_at.eq.${JSON.stringify(cursor.createdAt)},id.gt.${cursor.id}),created_at.gt.${JSON.stringify(cursor.createdAt)}`);
      const result = await query;
      if (result.error) throw failed(result.error);
      const replies = (result.data || []).map((row) => Object.assign(shapePost(row), { postId: row.post_id }));
      return { replies, nextCursor: replies.length < limit ? null : { createdAt: replies[replies.length - 1].createdAt, id: replies[replies.length - 1].id } };
    },
    async createReply(postId, body) {
      const session = await this.session();
      if (!session) throw new Error('Sign in before replying.');
      const result = await client.from('chess_replies').insert({ post_id: postId, author_id: session.user.id, body }).select('id').single();
      if (result.error) throw failed(result.error);
    },
    async deletePost(id) {
      const result = await client.from('chess_posts').delete().eq('id', id);
      if (result.error) throw failed(result.error);
    },
    async deleteReply(id) {
      const result = await client.from('chess_replies').delete().eq('id', id);
      if (result.error) throw failed(result.error);
    },
    async report({ postId, replyId, reason }) {
      const session = await this.session();
      if (!session) throw new Error('Sign in before reporting.');
      const row = { reporter_id: session.user.id, reason, post_id: postId, reply_id: replyId };
      const result = await client.from('chess_reports').insert(row).select('id').single();
      if (result.error) throw failed(result.error);
    },
    listen() {
      client.auth.onAuthStateChange(() => listener());
    }
  };
}
