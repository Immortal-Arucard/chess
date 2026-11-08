(function () {
  var button = document.querySelector('.menu-btn');
  var menu = document.getElementById('site-menu');

  var MAIN = 'https://theworldgovernmentincorporated.com';
  function abs(href) {
    if (href === 'self:/') return '/';
    if (/^https?:\/\//.test(href)) return href;
    return MAIN + href;
  }

  var tree = [
    { href: '/', name: 'Home' },
    {
      href: '/philosophy/',
      name: 'Philosophy',
      children: [
        {
          href: '/philosophy/politics/',
          name: 'Politics',
          children: [
            {
              href: '/philosophy/politics/democratic/',
              name: 'Democratic Politics',
              children: [
                {
                  href: '/philosophy/politics/democratic/american/',
                  name: 'American Democratic Politics',
                  children: [
                    {
                      href: '/philosophy/politics/democratic/american/drp/',
                      name: 'DRP',
                      children: [
                        { href: 'https://drp-party-platform.theworldgovernmentincorporated.com/', name: 'Platform' },
                        { href: 'https://political-compass.theworldgovernmentincorporated.com/', name: 'Compass' }
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    { href: '/religion/', name: 'Religion' },
    { href: '/science/', name: 'Science' },
    {
      href: '/recreation/',
      name: 'Recreation',
      children: [
        { href: 'self:/', name: 'Chess' }
      ]
    },
    { href: '/building/', name: 'Building' },
    { href: '/trading/', name: 'Trading' }
  ];

  function norm(path) {
    if (!path || path === '/') return '/';
    return path.replace(/\/index\.html$/, '/').replace(/\/?$/, '/');
  }

  function here() {
    return norm(location.pathname);
  }

  var seq = 0;

  function render(items) {
    return items.map(function (item) {
      var onChess = item.href === 'self:/' && here() === '/';
      var current = onChess ? ' aria-current="page"' : '';
      var link = '<a href="' + abs(item.href) + '"' + current + '>' + item.name + '</a>';
      if (!item.children) return '<div class="nav-item">' + link + '</div>';
      var id = 'nav-branch-' + (++seq);
      return '<div class="nav-item">' + link +
        '<button type="button" class="expand" aria-expanded="false" aria-controls="' + id + '" aria-label="Show categories inside ' + item.name + '"><span aria-hidden="true">+</span></button>' +
        '</div><ul id="' + id + '" class="nav-sub" hidden>' + render(item.children) + '</ul>';
    }).join('');
  }

  function setBranch(btn, open) {
    var panel = document.getElementById(btn.getAttribute('aria-controls'));
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    var label = btn.getAttribute('aria-label') || '';
    var name = label.replace(/^(Show|Hide) categories inside /, '');
    btn.setAttribute('aria-label', (open ? 'Hide' : 'Show') + ' categories inside ' + name);
    var glyph = btn.querySelector('[aria-hidden]');
    if (glyph) glyph.textContent = open ? '\u2212' : '+';
    if (panel) panel.hidden = !open;
  }

  function wire(root) {
    root.querySelectorAll('.expand').forEach(function (btn) {
      if (btn.getAttribute('data-wired') === 'true') return;
      btn.setAttribute('data-wired', 'true');
      btn.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        setBranch(btn, btn.getAttribute('aria-expanded') !== 'true');
      });
    });
  }

  if (menu) {
    menu.innerHTML = render(tree);
    wire(menu);
  }

  if (!button || !menu) return;

  function setOpen(open) {
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    menu.hidden = !open;
  }

  button.addEventListener('click', function (event) {
    event.stopPropagation();
    setOpen(button.getAttribute('aria-expanded') !== 'true');
  });

  document.addEventListener('click', function (event) {
    if (menu.hidden) return;
    if (button.contains(event.target) || menu.contains(event.target)) return;
    setOpen(false);
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    var active = document.activeElement;
    if (active && active.classList.contains('expand') && active.getAttribute('aria-expanded') === 'true' && !menu.contains(active)) {
      setBranch(active, false);
      return;
    }
    if (button.getAttribute('aria-expanded') !== 'true') return;
    setOpen(false);
    button.focus();
  });
})();
