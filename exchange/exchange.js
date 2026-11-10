const root = document.getElementById('exchange-app');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function group(value) {
  const text = String(value ?? '0');
  const neg = text.startsWith('-');
  const digits = neg ? text.slice(1) : text;
  if (!/^\d+$/.test(digits)) return text;
  return (neg ? '−' : '') + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function money(value) {
  return group(value) + ' AMU';
}

function when(value) {
  if (!value) return 'no as-of date';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

function kindLabel(kind) {
  if (kind === 'cached_public_api') return 'Cached public list';
  if (kind === 'site_rating') return 'On-site rating';
  return 'Snapshot';
}

function csrf() {
  const match = document.cookie.match(/(?:^|; )chess_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

async function readJson(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'The exchange could not be reached.');
  return body;
}

function getJson(path) {
  return fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' } }).then(readJson);
}

function postJson(path, body) {
  return fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf() },
    body: JSON.stringify(body)
  }).then(readJson);
}

function fact(className, label, value, note) {
  const box = el('div', 'ex-fact ' + className);
  box.append(el('b', '', label), el('span', '', value));
  if (note) box.append(el('small', '', note));
  return box;
}

function svgText(text) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  node.setAttribute('x', '16');
  node.setAttribute('y', '24');
  node.setAttribute('fill', '#c8c8c8');
  node.setAttribute('font-size', '12');
  node.textContent = text;
  return node;
}

function chart(points) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 320 140');
  svg.setAttribute('class', 'ex-chart');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Simulated AMU price chart. This is not a rating chart.');
  const prices = (points || []).map((point) => Number(point.price)).filter((price) => Number.isFinite(price));
  if (!prices.length) {
    svg.append(svgText('No simulated trades yet'));
    return svg;
  }
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min || 1;
  const coords = prices.map((price, index) => {
    const x = prices.length === 1 ? 160 : 12 + (index * 296) / (prices.length - 1);
    const y = 120 - ((price - min) / span) * 100;
    return x.toFixed(1) + ',' + y.toFixed(1);
  });
  const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  poly.setAttribute('fill', 'none');
  poly.setAttribute('stroke', '#4fc3ff');
  poly.setAttribute('stroke-width', '2');
  poly.setAttribute('points', coords.join(' '));
  svg.append(poly);
  if (points[0] && points[0].opening) svg.append(svgText('Opening simulated price'));
  return svg;
}

function levels(title, rows) {
  const panel = el('div', 'ex-panel');
  panel.append(el('h2', '', title));
  if (!rows || !rows.length) {
    panel.append(el('p', 'ex-status', 'No open orders.'));
    return panel;
  }
  rows.forEach((row) => {
    const line = el('div', 'ex-level');
    const maker = Number(row.makerQuantity) > 0 ? ' · Simulated market maker' : '';
    line.append(el('span', '', money(row.price) + maker), el('span', '', group(row.quantity) + ' shares'));
    panel.append(line);
  });
  return panel;
}

function route() {
  const hash = location.hash || '#/m/fide:standard';
  const instrument = hash.match(/^#\/i\/([0-9a-f-]{36})$/i);
  if (instrument) return { view: 'instrument', id: instrument[1] };
  if (hash === '#/portfolio') return { view: 'portfolio' };
  const market = hash.match(/^#\/m\/([a-z]+:[a-z0-9]+)$/);
  return { view: 'market', id: market ? market[1] : 'fide:standard' };
}

function shell(signedIn) {
  root.replaceChildren();
  const nav = el('nav', 'ex-nav');
  nav.setAttribute('aria-label', 'Exchange');
  const markets = el('a', '', 'Markets');
  markets.href = '#/m/fide:standard';
  const portfolio = el('a', '', 'Portfolio');
  portfolio.href = '#/portfolio';
  if (route().view === 'portfolio') portfolio.setAttribute('aria-current', 'page');
  else markets.setAttribute('aria-current', 'page');
  nav.append(markets, portfolio);
  root.append(nav);
  if (!signedIn) root.append(el('p', 'ex-status', 'Signed-out visitors can browse. Placing an order needs a signed-in Chess account.'));
}

function referenceNote(item) {
  const rating = item.referenceRating == null ? 'Unrated' : group(item.referenceRating);
  return rating + ' · ' + kindLabel(item.referenceKind) + ' · ' + (item.referenceSource || '') + ' · as of ' + when(item.referenceAsOf);
}

function quoteLine(item) {
  const bid = item.bid ? money(item.bid) : '—';
  const ask = item.ask ? money(item.ask) : '—';
  const maker = item.bidIsMarketMaker || item.askIsMarketMaker ? ' · Simulated market maker' : '';
  return 'Bid ' + bid + ' · Ask ' + ask + maker;
}

async function showMarket(signedIn) {
  const where = route();
  const markets = await getJson('/api/exchange/markets');
  const detail = await getJson('/api/exchange/markets/' + encodeURIComponent(where.id));
  shell(signedIn);
  const chips = el('div', 'ex-chips');
  (markets.markets || []).forEach((market) => {
    const link = el('a', 'ex-chip', market.title);
    link.href = '#/m/' + market.id;
    if (market.id === detail.market.id) link.setAttribute('aria-current', 'true');
    chips.append(link);
  });
  root.append(chips);
  root.append(el('p', 'ex-status', detail.market.ratingLabel + ' is reference data (' + kindLabel(detail.market.referenceKind) + ', as of ' + when(detail.market.asOf) + '). ' + detail.market.referenceSource + '. It is not a live quote and it is not the simulated price.'));
  const list = el('ul', 'ex-list');
  (detail.instruments || []).forEach((item) => {
    const li = el('li');
    const card = el('button', 'ex-card');
    card.type = 'button';
    card.append(el('strong', '', item.symbol + ' · ' + item.name));
    const meta = el('div', 'ex-meta');
    meta.append(
      fact('ex-ref', 'Reference rating', item.referenceRating == null ? '—' : group(item.referenceRating), referenceNote(item)),
      fact('ex-price', 'Simulated price', money(item.lastPrice), quoteLine(item))
    );
    card.append(meta);
    card.addEventListener('click', () => { location.hash = '#/i/' + item.id; });
    li.append(card);
    list.append(li);
  });
  if (!(detail.instruments || []).length) {
    root.append(el('p', 'ex-status', 'No instruments in this market yet. On-site markets list Chess accounts only after they have a rating above 0.'));
  }
  root.append(list);
}

function ticket(signedIn, item) {
  const panel = el('form', 'ex-panel ex-form');
  panel.append(el('h2', '', 'Order ticket'));
  panel.append(el('p', 'ex-status', 'This order spends simulated AMU only. It does not change the reference rating.'));
  const side = el('select');
  side.append(new Option('Buy', 'buy'), new Option('Sell', 'sell'));
  const type = el('select');
  type.append(new Option('Limit', 'limit'), new Option('Market', 'market'));
  const price = el('input');
  price.inputMode = 'numeric';
  price.autocomplete = 'off';
  price.value = item.ask || item.lastPrice || '';
  price.setAttribute('aria-label', 'Limit price in AMU');
  const qty = el('input');
  qty.inputMode = 'numeric';
  qty.autocomplete = 'off';
  qty.value = '1';
  qty.setAttribute('aria-label', 'Shares');
  const priceLabel = el('label', '', 'Limit price (AMU)');
  priceLabel.append(price);
  const qtyLabel = el('label', '', 'Shares');
  qtyLabel.append(qty);
  const sideLabel = el('label', '', 'Side');
  sideLabel.append(side);
  const typeLabel = el('label', '', 'Type');
  typeLabel.append(type);
  const notice = el('p', 'ex-status');
  notice.id = 'order-notice';
  const button = el('button', 'ex-btn primary', 'Place simulated order');
  button.type = 'submit';
  type.addEventListener('change', () => { priceLabel.hidden = type.value === 'market'; });
  panel.append(sideLabel, typeLabel, priceLabel, qtyLabel, notice, button);
  if (!signedIn) {
    button.disabled = true;
    notice.textContent = 'Sign in and join Chess to place a simulated order.';
  }
  panel.addEventListener('submit', async (event) => {
    event.preventDefault();
    notice.className = 'ex-status';
    notice.textContent = 'Sending the simulated order…';
    try {
      const result = await postJson('/api/exchange/orders', {
        instrumentId: item.id,
        side: side.value,
        orderType: type.value,
        price: type.value === 'limit' ? price.value.trim() : null,
        quantity: qty.value.trim()
      });
      const order = result.order;
      const text = 'Simulated ' + order.side + ' ' + order.orderType + ' order ' + order.status + '. Filled ' + order.filled + ' of ' + order.quantity + '.';
      await showInstrument(true);
      const status = document.getElementById('order-notice');
      if (status) status.textContent = text;
    } catch (err) {
      notice.className = 'ex-status ex-error';
      notice.textContent = err.message;
    }
  });
  return panel;
}

async function showInstrument(signedIn) {
  const detail = await getJson('/api/exchange/instruments/' + route().id);
  const item = detail.instrument;
  shell(signedIn);
  const back = el('a', 'ex-chip', detail.market.title);
  back.href = '#/m/' + detail.market.id;
  const row = el('div', 'ex-chips');
  row.append(back);
  root.append(row, el('h2', '', item.name + ' (' + item.symbol + ')'));
  const meta = el('div', 'ex-meta');
  meta.append(
    fact('ex-ref', 'Reference rating', item.referenceRating == null ? '—' : group(item.referenceRating), referenceNote(item)),
    fact('ex-price', 'Simulated last price', money(item.lastPrice), quoteLine(item))
  );
  const chartPanel = el('div', 'ex-panel');
  chartPanel.append(el('h2', '', 'Simulated price'), chart(detail.chart));
  chartPanel.append(el('p', 'ex-status', 'Each point is a simulated trade in AMU, or the opening simulated price when nobody has traded.'));
  const book = el('div', 'ex-book');
  book.append(levels('Bids', detail.book && detail.book.bids), levels('Asks', detail.book && detail.book.asks));
  const grid = el('div', 'ex-grid');
  grid.append(chartPanel, book);
  root.append(meta, grid, ticket(signedIn, item));
  const trades = el('div', 'ex-panel');
  trades.append(el('h2', '', 'Simulated trades'));
  if (!(detail.trades || []).length) trades.append(el('p', 'ex-status', 'No simulated trades yet.'));
  (detail.trades || []).forEach((trade) => {
    const line = el('div', 'ex-level');
    const who = trade.maker === 'simulated_market_maker' ? 'Resting quote from the simulated market maker' : 'Resting member order';
    line.append(el('span', '', money(trade.price) + ' · ' + group(trade.quantity)), el('i', '', who + ' · ' + when(trade.at)));
    trades.append(line);
  });
  root.append(trades);
}

function cells(tag, values, cell) {
  const row = el(tag);
  values.forEach((text) => row.append(el(cell, '', text)));
  return row;
}

async function showPortfolio(signedIn) {
  shell(signedIn);
  if (!signedIn) {
    root.append(el('p', 'ex-status', 'Sign in and join Chess to receive the one-time simulated balance of 1,000,000,000,000 AMU.'));
    return;
  }
  const [portfolio, board] = await Promise.all([
    getJson('/api/exchange/portfolio'),
    getJson('/api/exchange/leaderboard?limit=20')
  ]);
  const meta = el('div', 'ex-meta');
  meta.append(
    fact('ex-price', 'AMU balance', money(portfolio.balance), 'Reserved in open buys: ' + money(portfolio.reserved)),
    fact('ex-price', 'Portfolio value', money(portfolio.equity), 'Realized P&L ' + money(portfolio.realizedPnl) + ' · Unrealized P&L ' + money(portfolio.unrealizedPnl))
  );
  root.append(meta);
  const holdings = el('div', 'ex-panel');
  holdings.append(el('h2', '', 'Holdings'));
  if (!(portfolio.holdings || []).length) holdings.append(el('p', 'ex-status', 'No shares yet.'));
  const table = el('table', 'ex-table');
  const head = el('thead');
  head.append(cells('tr', ['Instrument', 'Shares', 'Avg cost', 'Simulated price', 'Value'], 'th'));
  const body = el('tbody');
  (portfolio.holdings || []).forEach((held) => {
    const tr = cells('tr', [held.symbol + ' · ' + held.name, group(held.quantity), money(held.avgCost), money(held.lastPrice), money(held.marketValue)], 'td');
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () => { location.hash = '#/i/' + held.instrumentId; });
    body.append(tr);
  });
  table.append(head, body);
  const scroll = el('div', 'ex-scroll');
  scroll.append(table);
  holdings.append(scroll);
  root.append(holdings);
  const orders = el('div', 'ex-panel');
  orders.append(el('h2', '', 'Open orders'));
  (portfolio.openOrders || []).forEach((order) => {
    const line = el('div', 'ex-level');
    line.append(el('span', '', order.side + ' ' + order.symbol + ' ' + order.filled + '/' + order.quantity + (order.price ? ' @ ' + money(order.price) : '')));
    const cancel = el('button', 'ex-btn', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', async () => {
      await postJson('/api/exchange/orders/cancel', { orderId: order.id });
      await showPortfolio(true);
    });
    line.append(cancel);
    orders.append(line);
  });
  if (!(portfolio.openOrders || []).length) orders.append(el('p', 'ex-status', 'No open orders.'));
  root.append(orders);
  const history = el('div', 'ex-panel');
  history.append(el('h2', '', 'Your simulated trades'));
  (portfolio.trades || []).forEach((trade) => {
    const line = el('div', 'ex-level');
    const who = trade.maker === 'simulated_market_maker' ? 'simulated market maker' : 'member';
    line.append(el('span', '', trade.side + ' ' + trade.symbol + ' ' + group(trade.quantity) + ' @ ' + money(trade.price)), el('i', '', who + ' · ' + when(trade.at)));
    history.append(line);
  });
  if (!(portfolio.trades || []).length) history.append(el('p', 'ex-status', 'No trades yet.'));
  root.append(history);
  const leaders = el('div', 'ex-panel');
  leaders.append(el('h2', '', 'Leaderboard'), el('p', 'ex-status', 'Ranked by simulated portfolio value in AMU.'));
  (board.entries || []).forEach((entry) => {
    const line = el('div', 'ex-level');
    line.append(el('span', '', entry.rank + '. ' + entry.displayName), el('span', '', money(entry.equity)));
    leaders.append(line);
  });
  if (!(board.entries || []).length) leaders.append(el('p', 'ex-status', 'No granted balances yet.'));
  root.append(leaders);
}

async function showFallback(message) {
  shell(false);
  root.append(el('p', 'ex-status ex-error', message));
  const catalog = await fetch('/exchange/instruments.json').then((response) => response.json());
  root.append(el('p', 'ex-status', 'Showing the stored reference snapshot only. These numbers are ratings, not market prices, bids, or asks. ' + (catalog.disclaimer || '')));
  const list = el('ul', 'ex-list');
  (catalog.markets || []).forEach((market) => {
    const card = el('li', 'ex-card');
    card.append(el('strong', '', market.title));
    card.append(el('p', 'ex-status', kindLabel(market.referenceKind) + ' · ' + (market.referenceSource || '') + ' · as of ' + when(market.asOf) + ' · ' + (market.players || []).length + ' seeded names'));
    list.append(card);
  });
  root.append(list);
}

async function signedIn() {
  try {
    const response = await fetch('/api/session', { credentials: 'same-origin' });
    if (!response.ok) return false;
    const body = await response.json();
    return !!(body && body.authenticated && body.profile);
  } catch (err) {
    return false;
  }
}

async function render() {
  const session = await signedIn();
  try {
    const where = route();
    if (where.view === 'portfolio') await showPortfolio(session);
    else if (where.view === 'instrument') await showInstrument(session);
    else await showMarket(session);
  } catch (err) {
    try {
      await showFallback(err.message || 'The market service is not reachable.');
    } catch (ignore) {
      shell(false);
      root.append(el('p', 'ex-status ex-error', 'The market service is not reachable.'));
    }
  }
}

window.addEventListener('hashchange', () => { void render(); });
void render();
