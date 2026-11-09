/* Account section contract.
   Copy this file to another TWGI origin (Chess does) and register that
   origin's section. Do not edit individual pages.

   A page shows the master control unless a registered section matches the
   page AND the signed-in user has that section's own account. Otherwise the
   master control stays. Signed-out visitors always see the master Log in,
   because a local account cannot be known without a session.

   Register one object:
     sectionId       string. Stable id, such as "chess". Required.
     label           string. Human name of the section. Not used as chip text.
     host            string or array of hostnames. No scheme and no port.
                     Omit to match any host.
     pathPrefixes    array of pathname prefixes. A prefix matches that path
                     and everything under it. Omit to match every path.
                     An entry with neither host nor pathPrefixes is ignored.
                     If both are set, both must match.
     signInUrl       string. The section's own sign-in URL. The shell does
                     not show it while signed out.
     hasLocalAccount function(session) -> boolean or Promise<boolean>.
                     Called only for a matching page with a signed-in user.
                     Return true only when THIS user has a row in the
                     section's own store. Read owner-scoped data only
                     (the caller's own row). Do not read other users, do not
                     write, and do not return a list. A throw or rejection
                     shows the master control.
     localProfile    function(session) -> { name, avatarUrl, url } or Promise.
                     Called only after hasLocalAccount returned true.
                     name     required string, shown as text, truncated.
                     avatarUrl optional. Only https is used; anything else
                              becomes initials.
                     url      required https URL, or a same-origin path
                              starting with a single slash. The chip opens it.
                     A missing name or url, or a throw, shows the master control.
     menuItems       optional array. Each item is either
                       { label, href } or { label, action: 'sign-out' }.
                     Default is Account (href = localProfile.url) and Log out.
                     Log out signs out the shared session with scope 'local'.
                     Labels are text. href follows the same url rule as above.

   session is { user } from the master sign-in. It includes id, email,
   user_metadata, and created_at. It does not include an access token.
   The shell never queries a section table itself and never lists which
   sections a person belongs to. Linkage stays owner-only.

   Matching: the longest matching path prefix wins. A host-only match ranks
   below any path match. The same rank keeps the earlier entry.

   Master control, when no local account applies:
     sign-in  /login/ on https://theworldgovernmentincorporated.com
              (same-origin path when this file is served from that host,
              or from localhost)
     account  /account/ the same way
     menu     Account and Log out
   On another origin, prefix those paths with the master origin.

   Chess mirror: one entry, host "chess.theworldgovernmentincorporated.com",
   no pathPrefixes. hasLocalAccount reads only that user's chess profile.
   localProfile returns the chess name, an https avatar, and the chess
   account URL. No chess profile: show the master control.
*/
(function (global) {
  var MASTER_ORIGIN = 'https://theworldgovernmentincorporated.com';
  var sections = [];

  function normalizePath(path) {
    var value = String(path || '/').split('?')[0].split('#')[0];
    if (!value || value.charAt(0) !== '/') value = '/' + value;
    if (value.length > 1 && value.charAt(value.length - 1) !== '/') value += '/';
    return value;
  }

  function hostsOf(section) {
    if (!section || section.host == null || section.host === '') return [];
    return Array.isArray(section.host) ? section.host : [section.host];
  }

  function prefixScore(section, path) {
    var prefixes = (section && section.pathPrefixes) || [];
    var best = 0;
    var i;
    for (i = 0; i < prefixes.length; i += 1) {
      var prefix = normalizePath(prefixes[i]);
      if (path === prefix || path.indexOf(prefix) === 0) {
        if (prefix.length > best) best = prefix.length;
      }
    }
    return best;
  }

  function sectionMatches(section, loc) {
    var hosts = hostsOf(section);
    var prefixes = (section && section.pathPrefixes) || [];
    if (!hosts.length && !prefixes.length) return false;
    var hostOk = !hosts.length || hosts.indexOf(loc.hostname) !== -1;
    var pathOk = !prefixes.length || prefixScore(section, normalizePath(loc.pathname)) > 0;
    return hostOk && pathOk;
  }

  function resolve(loc) {
    loc = loc || global.location;
    var path = normalizePath(loc.pathname);
    var best = null;
    var bestScore = -1;
    var i;
    for (i = 0; i < sections.length; i += 1) {
      var section = sections[i];
      if (!sectionMatches(section, loc)) continue;
      var score = prefixScore(section, path);
      var rank = score > 0 ? score : 1;
      if (rank > bestScore) {
        best = section;
        bestScore = rank;
      }
    }
    return best;
  }

  function onMasterHost() {
    var host = global.location && global.location.hostname;
    return host === 'theworldgovernmentincorporated.com' || host === 'localhost' || host === '127.0.0.1';
  }

  function masterUrls() {
    var origin = onMasterHost() ? '' : MASTER_ORIGIN;
    return {
      sectionId: 'master',
      label: 'TWGI',
      signInUrl: origin + '/login/',
      accountUrl: origin + '/account/'
    };
  }

  function safeHref(value) {
    var raw = String(value || '').trim();
    if (raw.charAt(0) === '/' && raw.charAt(1) !== '/' && raw.indexOf('\\') === -1) return raw;
    try {
      var url = new URL(raw);
      if (url.protocol === 'https:') return url.href;
    } catch (err) {}
    return '';
  }

  function masterLook(section) {
    return { kind: 'master', master: masterUrls(), section: section || null, local: null };
  }

  function appearance(session) {
    var section = resolve(global.location);
    var user = session && session.user;
    if (!section || !user || typeof section.hasLocalAccount !== 'function') {
      return Promise.resolve(masterLook(section));
    }
    return Promise.resolve().then(function () {
      return section.hasLocalAccount({ user: user });
    }).then(function (has) {
      if (!has || typeof section.localProfile !== 'function') return masterLook(section);
      return Promise.resolve(section.localProfile({ user: user })).then(function (profile) {
        var url = profile && safeHref(profile.url);
        var name = profile && String(profile.name || '').trim();
        if (!name || !url) return masterLook(section);
        return {
          kind: 'local',
          master: masterUrls(),
          section: section,
          local: {
            name: name,
            avatarUrl: profile.avatarUrl ? String(profile.avatarUrl) : '',
            url: url
          }
        };
      });
    }).catch(function () {
      return masterLook(section);
    });
  }

  function register(section) {
    if (!section || !section.sectionId) throw new Error('sectionId is required');
    sections.push(section);
    if (global.document && global.document.dispatchEvent) {
      global.document.dispatchEvent(new CustomEvent('twgi-account-sections'));
    }
    return section;
  }

  global.TWGIAccountSections = {
    masterOrigin: MASTER_ORIGIN,
    register: register,
    list: function () { return sections.slice(); },
    resolve: resolve,
    appearance: appearance,
    masterUrls: masterUrls,
    safeHref: safeHref
  };
})(window);
