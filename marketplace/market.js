const CATEGORIES = [
  ['boards', 'Boards'],
  ['sets', 'Sets'],
  ['clocks', 'Clocks'],
  ['books', 'Books'],
  ['art', 'Art'],
  ['apparel', 'Apparel'],
  ['lessons', 'Lessons and coaching'],
  ['digital', 'Digital items']
];
const RULE = 'Only chess-related items are allowed: boards, sets, clocks, books, art, apparel, lessons and coaching, and digital chess items such as courses or PGN collections. Anything that is not chess-related is not allowed and may be removed.';
const root = document.getElementById('market-app');
const params = new URLSearchParams(location.search);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function money(cents) {
  return '$' + (Number(cents || 0) / 100).toFixed(2);
}

function csrf() {
  const match = document.cookie.match(/(?:^|; )chess_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

async function get(path) {
  const response = await fetch(path, { credentials: 'same-origin' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'The marketplace could not be loaded.');
  return body;
}

async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf() },
    body: JSON.stringify(body || {})
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'The marketplace request failed.');
  return payload;
}

function categoryName(id) {
  const found = CATEGORIES.find((item) => item[0] === id);
  return found ? found[1] : id;
}

function card(listing) {
  const article = el('article', 'market-card');
  const link = el('a', null, listing.title);
  link.href = '/marketplace/?listing=' + listing.id;
  article.append(el('p', null, categoryName(listing.category) + ' · ' + money(listing.priceCents)));
  article.append(link);
  article.append(el('p', null, (listing.location || 'Digital') + (listing.openToTrades ? ' · Open to trades' : '')));
  return article;
}

function listingForm(notice) {
  const form = el('form', 'market-form');
  form.append(el('h2', null, 'List an item'));
  form.append(el('p', 'market-rule', RULE));
  const fields = [
    ['title', 'Title', 'text'],
    ['price', 'Price in USD', 'number'],
    ['quantity', 'Quantity', 'number'],
    ['location', 'City or region', 'text']
  ];
  fields.forEach(([name, label, type]) => {
    const wrap = el('label', null, label);
    const input = document.createElement('input');
    input.name = name;
    input.type = type;
    if (type === 'number') input.min = name === 'price' ? '0' : '1';
    wrap.append(input);
    form.append(wrap);
  });
  const description = el('label', null, 'Description');
  const area = document.createElement('textarea');
  area.name = 'description';
  description.append(area);
  form.append(description);
  [['category', 'Category', CATEGORIES], ['condition', 'Condition', [['new', 'New'], ['like_new', 'Like new'], ['good', 'Good'], ['fair', 'Fair'], ['digital', 'Digital']]], ['fulfillment', 'Delivery', [['shipping', 'Shipping'], ['pickup', 'Pickup'], ['digital', 'Digital']]]].forEach(([name, label, options]) => {
    const wrap = el('label', null, label);
    const select = document.createElement('select');
    select.name = name;
    options.forEach(([value, text]) => {
      const option = el('option', null, text);
      option.value = value;
      select.append(option);
    });
    wrap.append(select);
    form.append(wrap);
  });
  const trades = el('label', null, 'Open to trades');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.name = 'openToTrades';
  trades.append(box);
  const photos = el('label', null, 'Photos, up to 4');
  const files = document.createElement('input');
  files.type = 'file';
  files.name = 'photos';
  files.accept = 'image/jpeg,image/png,image/webp';
  files.multiple = true;
  photos.append(files);
  const submit = el('button', 'tool', 'Publish listing');
  submit.type = 'submit';
  form.append(trades, photos, submit);
  if (notice) form.append(el('p', null, notice));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const dollars = Number(data.get('price'));
    post('/api/market/listings', {
      title: data.get('title'),
      description: data.get('description'),
      category: data.get('category'),
      condition: data.get('condition'),
      priceCents: Number.isFinite(dollars) ? Math.round(dollars * 100) : 0,
      quantity: Number(data.get('quantity')),
      fulfillment: data.get('fulfillment'),
      location: data.get('location'),
      openToTrades: data.get('openToTrades') === 'on'
    }).then(async (listing) => {
      const chosen = files.files ? [...files.files].slice(0, 4) : [];
      for (const file of chosen) {
        await fetch('/api/market/listings/' + listing.id + '/photo', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': file.type, 'x-csrf-token': csrf() },
          body: file
        });
      }
      location.assign('/marketplace/?listing=' + listing.id);
    }).catch((err) => {
      form.append(el('p', null, err.message));
    });
  });
  return form;
}

function detail(listing, config) {
  const panel = el('article', 'market-detail');
  panel.append(el('h2', null, listing.title));
  panel.append(el('p', null, categoryName(listing.category) + ' · ' + listing.condition + ' · ' + money(listing.priceCents)));
  panel.append(el('p', null, listing.description));
  panel.append(el('p', null, listing.fulfillment + (listing.location ? ' · ' + listing.location : '') + ' · ' + listing.quantity + ' available'));
  (listing.photos || []).forEach((photo) => {
    const image = document.createElement('img');
    image.className = 'market-photo';
    image.alt = listing.title;
    image.src = '/api/market/photos/' + photo.id;
    panel.append(image);
  });
  const actions = el('div', 'market-actions');
  const buy = el('button', 'tool', config.checkoutEnabled ? 'Buy' : 'Checkout not yet enabled');
  buy.type = 'button';
  buy.disabled = !config.checkoutEnabled || listing.priceCents < 50 || listing.mine;
  buy.addEventListener('click', () => {
    post('/api/market/listings/' + listing.id + '/checkout', { quantity: 1 }).then((result) => {
      if (result.url) location.assign(result.url);
      else panel.append(el('p', 'market-banner', 'Checkout not yet enabled'));
    }).catch((err) => panel.append(el('p', null, err.message)));
  });
  actions.append(buy);
  if (config.profileId && !listing.mine) {
    const message = el('a', 'tool', 'Message seller');
    message.href = '/community/messages/?with=' + listing.sellerId;
    actions.append(message);
  }
  panel.append(actions);
  const report = el('form', 'market-actions');
  const reason = document.createElement('select');
  reason.setAttribute('aria-label', 'Report reason');
  [['not_chess', 'Not chess-related'], ['scam', 'Scam'], ['other', 'Other']].forEach(([value, text]) => {
    const option = el('option', null, text);
    option.value = value;
    reason.append(option);
  });
  const reportButton = el('button', 'tool', 'Report');
  reportButton.type = 'submit';
  report.append(reason, reportButton);
  report.addEventListener('submit', (event) => {
    event.preventDefault();
    post('/api/market/listings/' + listing.id + '/report', { reason: reason.value, note: '' }).then(() => {
      panel.append(el('p', null, 'Report sent.'));
    }).catch((err) => panel.append(el('p', null, err.message)));
  });
  panel.append(report);
  if (listing.openToTrades && config.profileId && !listing.mine) {
    const trade = el('form', 'market-form');
    trade.append(el('h3', null, 'Offer a trade'));
    const offered = el('label', null, 'Your listing id');
    const input = document.createElement('input');
    input.name = 'offeredId';
    offered.append(input);
    const cash = el('label', null, 'Cash on top, in USD');
    const amount = document.createElement('input');
    amount.name = 'cash';
    amount.type = 'number';
    amount.min = '0';
    amount.value = '0';
    cash.append(amount);
    const payer = document.createElement('select');
    payer.setAttribute('aria-label', 'Who pays the cash');
    [['none', 'No cash'], ['offerer', 'I pay cash'], ['owner', 'They pay cash']].forEach(([value, text]) => {
      const option = el('option', null, text);
      option.value = value;
      payer.append(option);
    });
    const send = el('button', 'tool', 'Offer trade');
    send.type = 'submit';
    trade.append(offered, cash, payer, send);
    trade.addEventListener('submit', (event) => {
      event.preventDefault();
      const dollars = Number(amount.value || 0);
      post('/api/market/trades', {
        offeredId: input.value,
        requestedId: listing.id,
        cashCents: payer.value === 'none' ? 0 : Math.round(dollars * 100),
        cashPayer: payer.value
      }).then(() => panel.append(el('p', null, 'Trade offered.'))).catch((err) => panel.append(el('p', null, err.message)));
    });
    panel.append(trade);
  }
  return panel;
}

async function render() {
  await get('/api/session').catch(() => null);
  const config = await get('/api/market/config');
  root.replaceChildren();
  root.append(el('p', 'market-rule', RULE));
  if (!config.checkoutEnabled) root.append(el('p', 'market-banner', 'Checkout not yet enabled'));
  const tools = el('div', 'market-tools');
  const search = document.createElement('input');
  search.setAttribute('aria-label', 'Search listings');
  search.value = params.get('q') || '';
  const category = document.createElement('select');
  category.setAttribute('aria-label', 'Category');
  const any = el('option', null, 'All chess categories');
  any.value = '';
  category.append(any);
  CATEGORIES.forEach(([value, text]) => {
    const option = el('option', null, text);
    option.value = value;
    if (params.get('category') === value) option.selected = true;
    category.append(option);
  });
  const go = el('button', 'tool', 'Search');
  go.type = 'button';
  go.addEventListener('click', () => {
    const next = new URLSearchParams();
    if (search.value) next.set('q', search.value);
    if (category.value) next.set('category', category.value);
    location.assign('/marketplace/' + (next.toString() ? '?' + next : ''));
  });
  tools.append(search, category, go);
  if (config.profileId) {
    const sell = el('a', 'tool', 'Sell');
    sell.href = '/marketplace/?sell=1';
    const orders = el('a', 'tool', 'My orders');
    orders.href = '/marketplace/?orders=1';
    const sales = el('a', 'tool', 'My sales');
    sales.href = '/marketplace/?sales=1';
    const trades = el('a', 'tool', 'My trades');
    trades.href = '/marketplace/?trades=1';
    const payouts = el('button', 'tool', 'Seller payouts');
    payouts.type = 'button';
    payouts.addEventListener('click', () => {
      post('/api/market/connect', {}).then((result) => {
        if (result.url) location.assign(result.url);
        else root.append(el('p', 'market-banner', 'Checkout not yet enabled'));
      }).catch((err) => root.append(el('p', null, err.message)));
    });
    const dashboard = el('button', 'tool', 'Express dashboard');
    dashboard.type = 'button';
    dashboard.addEventListener('click', () => {
      post('/api/market/connect/login', {}).then((result) => {
        if (result.url) location.assign(result.url);
        else root.append(el('p', 'market-banner', 'Checkout not yet enabled'));
      }).catch((err) => root.append(el('p', null, err.message)));
    });
    tools.append(sell, orders, sales, trades, payouts, dashboard);
  }
  if (config.admin) {
    const queue = el('a', 'tool', 'Moderation');
    queue.href = '/marketplace/?moderation=1';
    const disputes = el('a', 'tool', 'Disputes');
    disputes.href = '/marketplace/?disputes=1';
    tools.append(queue, disputes);
  }
  root.append(tools);
  if (params.get('listing')) {
    const listing = await get('/api/market/listings/' + params.get('listing'));
    root.append(detail(listing, config));
    return;
  }
  if (params.get('sell') === '1') {
    root.append(listingForm(config.profileId ? '' : 'Sign in and join Chess before selling.'));
    return;
  }
  if (params.get('trades') === '1') {
    const body = await get('/api/market/trades');
    const list = el('div', 'market-grid');
    (body.trades || []).forEach((trade) => {
      const item = el('article', 'market-card');
      item.append(el('p', null, trade.status + (trade.cashCents ? ' · cash ' + money(trade.cashCents) : '')));
      if (trade.canPay) {
        const pay = el('button', 'tool', config.checkoutEnabled ? 'Pay the cash' : 'Checkout not yet enabled');
        pay.type = 'button';
        pay.disabled = !config.checkoutEnabled;
        pay.addEventListener('click', () => {
          post('/api/market/trades/' + trade.id + '/checkout', {}).then((result) => {
            if (result.url) location.assign(result.url);
          }).catch((err) => item.append(el('p', null, err.message)));
        });
        item.append(pay);
      }
      list.append(item);
    });
    root.append(list);
    return;
  }
  if (params.get('disputes') === '1' && config.admin) {
    const body = await get('/api/market/disputes');
    const list = el('div', 'market-grid');
    (body.disputes || []).forEach((dispute) => {
      const item = el('article', 'market-card');
      item.append(el('p', null, dispute.title + ' · ' + (dispute.disputeStatus || dispute.status) + (dispute.reversalNeeded ? ' · reversal needed' : '')));
      list.append(item);
    });
    root.append(list);
    return;
  }
  if (params.get('orders') === '1' || params.get('sales') === '1') {
    const path = params.get('sales') === '1' ? '/api/market/sales' : '/api/market/orders';
    const body = await get(path);
    const list = el('div', 'market-grid');
    (body.orders || []).forEach((order) => {
      const item = el('article', 'market-card');
      item.append(el('p', null, order.title + ' · ' + money(order.totalCents) + ' · ' + order.status));
      if (order.shipLine1) item.append(el('p', null, [order.shipName, order.shipLine1, order.shipCity, order.shipState, order.shipPostal, order.shipCountry].filter(Boolean).join(', ')));
      if (params.get('sales') === '1' && order.status === 'paid') {
        const ship = el('button', 'tool', 'Mark shipped');
        ship.type = 'button';
        ship.addEventListener('click', () => {
          const tracking = window.prompt('Tracking number, optional') || '';
          post('/api/market/orders/' + order.id + '/ship', { tracking }).then(() => location.reload()).catch((err) => item.append(el('p', null, err.message)));
        });
        item.append(ship);
      }
      list.append(item);
    });
    root.append(list);
    return;
  }
  if (params.get('moderation') === '1' && config.admin) {
    const body = await get('/api/market/moderation');
    const list = el('div', 'market-grid');
    (body.listings || []).forEach((listing) => {
      const item = el('article', 'market-card');
      item.append(el('p', null, listing.title + ' · ' + listing.reports + ' reports · ' + listing.status));
      ['hide', 'remove', 'restore'].forEach((action) => {
        const button = el('button', 'tool', action);
        button.type = 'button';
        button.addEventListener('click', () => {
          post('/api/market/moderation/' + listing.id, { action }).then(() => location.reload()).catch((err) => item.append(el('p', null, err.message)));
        });
        item.append(button);
      });
      list.append(item);
    });
    root.append(list);
    return;
  }
  const found = await get('/api/market/listings?q=' + encodeURIComponent(params.get('q') || '') + '&category=' + encodeURIComponent(params.get('category') || ''));
  const grid = el('div', 'market-grid');
  (found.listings || []).forEach((listing) => grid.append(card(listing)));
  if (!(found.listings || []).length) grid.append(el('p', null, 'No chess listings match that search.'));
  root.append(grid);
}

render().catch((err) => {
  root.replaceChildren(el('p', null, err.message));
});
