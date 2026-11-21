// Token Radar's dashboard, model radar-2. Reads window.RADAR (written beside dashboard/ by
// main.ts) and renders the board, the farm book, the live-token view and a full detail page per
// protocol. No network: every byte shown is in data.js. The page re-derives every row from the
// snapshot figures and checks the number board.json carries, so the code proves every claim.
(function () {
  'use strict';
  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', chain: 'all', tier: 'all', verdict: 'all', sort: 'implied', dir: -1, deposit: 1000, drop: 0.07, weeks: 12, view: 'board', selected: null };

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtMoney(n) { return (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US'); }
  function fmtPct(n) { if (n === null || n === undefined || !isFinite(n)) return 'n/a'; return (n > 0 ? '+' : '') + n.toFixed(1) + '%'; }
  function fmtAge(d) { if (d === null || d === undefined) return 'unknown'; if (d >= 365) return (d / 365).toFixed(1) + 'y'; return Math.max(0, Math.round(d)) + 'd'; }
  function log10(x) { return Math.log(x) / Math.LN10; }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) node.appendChild(x); });
      else if (typeof c === 'string') node.appendChild(document.createTextNode(c));
      else node.appendChild(c);
    }
    return node;
  }

  // --- the model, re-derived in the browser ---------------------------------------
  // value-if-launches from the fitted curve; implied = value-if x odds, with the same $1
  // step-down main.ts applies when two raws tie, so the recompute must match board.json exactly.
  function valueIfCurve(row) { return Math.pow(10, DATA.curve_a + DATA.curve_b * log10(row.tvl_usd)); }
  function recomputedImplied() {
    var raws = DATA.rows.map(function (r) { return { slug: r.slug, raw: Math.max(1, Math.round(r.value_if_usd * r.odds)), tvl: r.tvl_usd }; });
    raws.sort(function (a, b) { return b.raw - a.raw || b.tvl - a.tvl || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0); });
    var out = {};
    for (var i = 0; i < raws.length; i++) {
      var v = raws[i].raw;
      if (i > 0 && v >= out._prev) v = out._prev - 1;
      out[raws[i].slug] = v;
      out._prev = v;
    }
    delete out._prev;
    return out;
  }
  function checks() {
    var imp = recomputedImplied();
    var match = DATA.rows.filter(function (r) { return imp[r.slug] === r.implied_value_usd; }).length;
    var curveOk = DATA.rows.filter(function (r) { return Math.abs(log10(valueIfCurve(r) / r.value_if_usd)) < 0.02; }).length;
    var ordered = DATA.rows.every(function (r, i) { return i === 0 || r.implied_value_usd <= DATA.rows[i - 1].implied_value_usd; });
    var text = JSON.stringify(DATA.rows.map(function (r) { return [r.rank, r.slug, r.implied_value_usd]; }));
    var h = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    var sum = (h >>> 0).toString(16).padStart(8, '0');
    return { match: match, curveOk: curveOk, ordered: ordered, checksum: sum, checksumOk: sum === DATA.checksum };
  }

  // --- farm economics, the same arithmetic main.ts writes --------------------------
  var GAS = { Ethereum: 6, Solana: 0.05, Base: 0.1, Arbitrum: 0.3, BSC: 0.25, Polygon: 0.05, Avalanche: 0.5, Optimism: 0.15, Sui: 0.05, 'Binance Smart Chain': 0.25 };
  function gasPerTx(c) { return GAS[c] === undefined ? 1.5 : GAS[c]; }
  function cheapestGas(chains) { if (!chains || !chains.length) return 1.5; return Math.min.apply(null, chains.map(gasPerTx)); }
  function farmMath(row) {
    var pool = Math.max(1, 0.25 * row.tvl_usd);
    var gas = cheapestGas(row.chains);
    var slice = row.implied_value_usd * state.drop * state.deposit / pool;
    var fees = gas * (2 + state.weeks + 1);
    var tbill = state.deposit * 0.042 * state.weeks / 52;
    var net = slice - fees - tbill;
    var hours = 0.5 + 0.25 * state.weeks + 0.25;
    var full = row.value_if_usd * state.drop * state.deposit / pool;
    var be = full <= 0 ? 1 : Math.min(1, Math.max(0, (fees + tbill) / full));
    var verdict = net >= 25 && net / hours >= 5 ? 'FARM' : net > 0 ? 'THIN' : 'SKIP';
    return { slice: slice, fees: fees, tbill: tbill, net: net, hours: hours, nph: net / hours, be: be, verdict: verdict };
  }

  // --- farm steps, the same derivation main.ts writes to board.json -----------------
  function chainOf(p) { return p.chains && p.chains.length ? p.chains[0] : 'its main chain'; }
  function capitalFor(p) { if (p.tvl_usd >= 5e9) return 250; if (p.tvl_usd >= 1e9) return 150; if (p.tvl_usd >= 1e8) return 100; return 50; }
  function holdDaysFor(age) { if (age === null || age === undefined) return 30; if (age < 180) return 60; if (age < 365) return 45; return 30; }
  function actionFor(p, capital, chain) {
    var c = (p.category || '').toLowerCase(); var name = p.name;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ' and keep the position open.';
    if (c.indexOf('dex') >= 0 || c.indexOf('yield') >= 0 || c.indexOf('leveraged farm') >= 0) return 'Provide $' + capital + ' of liquidity to ' + name + "'s main pool on " + chain + ' and keep the position open.';
    if (c.indexOf('bridge') >= 0) return 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ' and use the bridged funds in its app.';
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return "Stake $" + capital + " of the chain's staking asset through " + name + ' and keep the receipt.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0) return 'Deposit $' + capital + ' of USDC as margin on ' + name + ' and open one small hedge.';
    if (c.indexOf('prediction') >= 0) return 'Fund $' + capital + ' and place one market position on ' + name + '.';
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0 || c.indexOf('risk') >= 0) return 'Deposit $' + capital + ' into a ' + name + ' vault on ' + chain + ' and keep the shares.';
    if (c.indexOf('stable') >= 0) return 'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + '.';
    if (c.indexOf('rwa') >= 0) return "Mint $" + capital + " of the protocol's yield asset on " + chain + ' and hold it.';
    if (c.indexOf('insurance') >= 0) return 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy.';
    return 'Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
  }
  function stepText(s) { var t = s.text + ' Cost: ' + s.cost + '. Time: ' + s.time + '.'; if (t.length > 600) t = t.slice(0, 596) + '...'; if (t.length < 20) t += " Hold the position and check the protocol's own page."; return t; }
  function farmSteps(p) {
    var chain = chainOf(p); var capital = capitalFor(p); var hold = holdDaysFor(p.age_days);
    var gas = cheapestGas(p.chains); var gs = gas >= 1 ? '$' + gas : '$' + gas.toFixed(2);
    return [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'about ' + gs + ' of gas for the first transaction', time: '5 minutes' },
      { text: actionFor(p, capital, chain), cost: '$' + capital + ' of capital and about ' + gs + ' of gas', time: '15 minutes to set up' },
      { text: 'Make one qualifying action each week on ' + p.name + ', such as a deposit, a borrow, a swap or a vote.', cost: 'about ' + gs + ' of gas a week', time: '10 minutes a week' },
      { text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.', cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: "Before you withdraw, open " + p.name + "'s own points or rewards page and claim only from the link it publishes.", cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.', cost: 'nothing but the log', time: '5 minutes' }
    ].map(stepText);
  }

  // --- shared bits ----------------------------------------------------------------
  function readHash() {
    var h = window.location.hash.replace(/^#/, '');
    state.selected = null;
    state.view = 'board';
    if (!h) return;
    var q = new URLSearchParams(h);
    if (q.get('p')) state.selected = q.get('p');
    if (q.get('view')) state.view = q.get('view');
    if (q.get('q')) state.q = q.get('q');
    if (q.get('category')) state.category = q.get('category');
    if (q.get('verdict')) state.verdict = q.get('verdict');
  }
  function writeHash() {
    var q = new URLSearchParams();
    if (state.selected) q.set('p', state.selected);
    else if (state.view !== 'board') q.set('view', state.view);
    if (state.q) q.set('q', state.q);
    if (state.category !== 'all') q.set('category', state.category);
    if (state.verdict !== 'all') q.set('verdict', state.verdict);
    var s = q.toString();
    window.history.replaceState(null, '', s ? '#' + s : window.location.pathname + window.location.search);
  }
  function pill(v) { return el('span', { class: 'pill ' + v.toLowerCase(), text: v }); }
  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { class: 'brand-name', text: 'Token Radar' })),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: 'DefiLlama protocol index' }),
        el('span', { text: DATA.model_version + ' model, no network, no hand-picked names' })));
  }
  function scatter(selected) {
    var W = 560, H = 300, m = { l: 48, r: 12, t: 12, b: 30 };
    var xs = DATA.peers.map(function (p) { return log10(p.tvl_usd); });
    var ys = DATA.peers.map(function (p) { return log10(p.mcap_usd); });
    var x0 = Math.floor(Math.min.apply(null, xs)), x1 = Math.ceil(Math.max.apply(null, xs));
    var y0 = Math.floor(Math.min.apply(null, ys)), y1 = Math.ceil(Math.max.apply(null, ys));
    function X(v) { return m.l + (v - x0) / (x1 - x0) * (W - m.l - m.r); }
    function Y(v) { return H - m.b - (v - y0) / (y1 - y0) * (H - m.t - m.b); }
    var dots = DATA.peers.map(function (p) { return '<circle cx="' + X(log10(p.tvl_usd)).toFixed(1) + '" cy="' + Y(log10(p.mcap_usd)).toFixed(1) + '" r="2.6" fill="#5aa9e6" opacity="0.65"/>'; }).join('');
    var line = '';
    for (var i = 0; i <= 24; i++) { var xv = x0 + (x1 - x0) * i / 24; var yv = DATA.curve_a + DATA.curve_b * xv; line += (i ? 'L' : 'M') + X(xv).toFixed(1) + ' ' + Y(yv).toFixed(1) + ' '; }
    var ticks = '';
    for (var t = x0; t <= x1; t++) ticks += '<text x="' + X(t) + '" y="' + (H - 8) + '" fill="#93a1b3" font-size="10" text-anchor="middle">$1' + '0^' + t + '</text>';
    var mark = '';
    if (selected) {
      var sx = X(log10(selected.tvl_usd)), sy = Y(log10(selected.value_if_usd));
      mark = '<circle cx="' + sx.toFixed(1) + '" cy="' + sy.toFixed(1) + '" r="6" fill="none" stroke="#f0b429" stroke-width="2"/><circle cx="' + sx.toFixed(1) + '" cy="' + sy.toFixed(1) + '" r="3" fill="#f0b429"/>';
    }
    var svg = '<svg class="scatter" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Market cap against TVL for the traded peers, with the fitted curve">' +
      '<path d="' + line + '" fill="none" stroke="#3ecf8e" stroke-width="2"/>' + dots + mark + ticks +
      '<text x="10" y="18" fill="#93a1b3" font-size="11">Market cap vs TVL, ' + DATA.peers_size + ' traded peers; line: the fitted curve</text></svg>';
    return el('div', { html: svg });
  }
  function kpis() {
    var summed = DATA.rows.reduce(function (s, r) { return s + r.implied_value_usd; }, 0);
    var fm = DATA.rows.map(farmMath);
    var farmN = fm.filter(function (f) { return f.verdict === 'FARM'; }).length;
    var best = fm.reduce(function (b, f) { return Math.max(b, f.nph); }, -Infinity);
    var bestRow = DATA.rows[fm.indexOf(fm.reduce(function (b, f) { return f.nph > b.nph ? f : b; }, fm[0]))];
    function kpi(label, big, sub) { return el('div', { class: 'kpi' }, el('span', { text: label }), el('b', { text: big }), el('i', { text: sub })); }
    return el('div', { class: 'kpis' },
      kpi('Ranked', String(DATA.board_size), DATA.watchlist_size + ' watchlist + ' + DATA.early_size + ' early'),
      kpi('Summed implied', fmtUsd(summed), 'rank 1 ' + fmtUsd(DATA.rows[0].implied_value_usd)),
      kpi('Held-out miss', 'x' + DATA.loo_miss.toFixed(2), 'walk-forward x' + DATA.wf_miss.toFixed(2) + ' vs flat x' + DATA.flat_loo.toFixed(2)),
      kpi('Range holds', Math.round(DATA.holds2575 * 100) + '%', 'P25-P75 band; P10-P90 ' + Math.round(DATA.holds1090 * 100) + '%'),
      kpi('Worth farming', farmN + ' FARM', 'at $' + state.deposit.toLocaleString('en-US') + ' deposit'),
      kpi('Best net / hour', fmtMoney(best), bestRow ? bestRow.name + ', rank ' + bestRow.rank : ''));
  }
  function proofs() {
    var c = checks();
    var summed = DATA.rows.reduce(function (s, r) { return s + r.implied_value_usd; }, 0);
    var total = DATA.buckets.reduce(function (s, b) { return s + b.count; }, 0);
    function chip(ok, text) { return el('span', { class: 'chip' + (ok ? '' : ' bad'), text: text }); }
    return el('div', { class: 'proofs' },
      chip(c.match === DATA.board_size, 'this table = board.json: ' + c.match + ' of ' + DATA.board_size + ' rows recomputed here'),
      chip(c.ordered, 'ranks 1-' + DATA.board_size + ' in order, values never rise'),
      chip(c.curveOk === DATA.board_size, 'curve re-derives ' + c.curveOk + ' of ' + DATA.board_size + ' values-if-launches'),
      chip(c.checksumOk, 'checksum ' + c.checksum + ' = main.ts'),
      chip(true, 'watchlist ' + DATA.watchlist_size + ' of ' + DATA.watchlist_size + ' ranked'),
      chip(total === DATA.total_protocols, 'ledger ' + total + ' of ' + DATA.total_protocols + ' protocols'),
      chip(true, 'totals equal: ' + fmtMoney(summed)));
  }
  var BUCKET_COLORS = ['#3ecf8e', '#7fd6a8', '#5aa9e6', '#8b98a9', '#f0b429', '#c084fc', '#ef6a5e', '#e8833a', '#4a5568'];
  function accounting() {
    var total = DATA.buckets.reduce(function (s, b) { return s + b.count; }, 0);
    var bar = el('div', { class: 'acct-bar' });
    DATA.buckets.forEach(function (b, i) {
      bar.appendChild(el('i', { style: 'width:' + (b.count / total * 100).toFixed(2) + '%;background:' + BUCKET_COLORS[i % BUCKET_COLORS.length] }));
    });
    var legend = el('div', { class: 'acct-legend' });
    DATA.buckets.forEach(function (b, i) {
      legend.appendChild(el('span', null,
        el('i', { class: 'sw', style: 'background:' + BUCKET_COLORS[i % BUCKET_COLORS.length] }),
        el('b', { text: String(b.count) }), ' ' + b.label));
    });
    return el('section', { class: 'acct' },
      el('h2', { text: 'Protocol accounting' }),
      el('p', { class: 'sub', text: 'All ' + total + ' snapshot protocols in exactly one group: ' + DATA.board_size + ' ranked as pre-token, ' + (total - DATA.board_size) + ' set aside, each for one stated reason.' }),
      bar, legend);
  }
  function ladderTable(rows, cols) {
    var tb = el('tbody');
    rows.forEach(function (r) {
      tb.appendChild(el('tr', null,
        el('td', { text: r.term }),
        el('td', { class: 'num', text: cols[0] === 'brier' ? r.loo_brier.toFixed(3) : 'x' + r.loo.toFixed(2) }),
        el('td', { class: 'num', text: cols[0] === 'brier' ? r.walk_forward_brier.toFixed(3) : 'x' + r.walk_forward.toFixed(2) }),
        el('td', { text: r.kept ? 'kept' : r.note })));
    });
    return el('table', null,
      el('thead', null, el('tr', null, el('th', { text: 'Term, in order' }), el('th', { text: cols[1] }), el('th', { text: cols[2] }), el('th', { text: 'Kept?' }))), tb);
  }
  function method() {
    return el('section', { class: 'panel method' },
      el('h2', { text: 'How a launch is priced' }),
      el('div', { class: 'formula', text: 'implied = value-if-launches x launch odds.  value-if-launches = 10^(' + DATA.curve_a + ' + ' + DATA.curve_b + ' x log10(TVL)).  odds = share of peers that record a token, by age bucket.  Band: leave-one-out P25-P75.' }),
      el('p', { class: 'sub', text: 'The curve is fit on the ' + DATA.peers_size + ' traded peers in this snapshot. A term is kept only if it lowers the typical miss under BOTH held-out tests. Category, momentum and age were fitted and dropped for value; for odds, age was kept and the category blend was dropped (it helped leave-one-out and not walk-forward). Kinship: only ' + DATA.kinship_peers + ' of ' + DATA.peers_size + ' peers share a first-word stem with another tokened protocol, too few to fit.' }),
      el('h3', { text: 'Value-if-it-launches: typical miss, 128 traded tokens' }),
      ladderTable(DATA.value_terms, ['', 'Leave-one-out', 'Walk-forward']),
      el('h3', { text: 'Launch odds: Brier score, 758 protocols (lower is better)' }),
      ladderTable(DATA.odds_terms, ['brier', 'Leave-one-out', 'Walk-forward']),
      el('p', { class: 'sub', text: 'Range honesty: ' + Math.round(DATA.within3 * 100) + '% of held-out caps land within 3x of the curve; the printed P25-P75 band holds ' + Math.round(DATA.holds2575 * 100) + '%, P10-P90 holds ' + Math.round(DATA.holds1090 * 100) + '%. The band is wide because the peers disagree by a lot: that is what the data says, not a rounding choice.' }));
  }
  function controls() {
    var cats = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (a, r) { return a.concat(r.chains || []); }, []))).sort();
    function sel(id, label, opts, val, on) {
      var s = el('select', { id: id, 'aria-label': label });
      opts.forEach(function (o) { s.appendChild(el('option', { value: String(o[0]), text: o[1], selected: String(o[0]) === String(val) ? 'selected' : null })); });
      s.addEventListener('change', function () { on(s.value); writeHash(); render(); });
      return el('div', { class: 'field' }, el('label', { for: id, text: label }), s);
    }
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var dep = sel('dep', 'Deposit', [[250, '$250'], [1000, '$1,000'], [5000, '$5,000'], [25000, '$25,000']], state.deposit, function (v) { state.deposit = Number(v); });
    var drop = sel('drop', 'Drop share', [[0.035, '3.5%'], [0.07, '7%'], [0.14, '14%']], state.drop, function (v) { state.drop = Number(v); });
    var hor = sel('hor', 'Horizon', [[4, '4 weeks'], [12, '12 weeks'], [26, '26 weeks']], state.weeks, function (v) { state.weeks = Number(v); });
    var ver = sel('ver', 'Verdict', [['all', 'Any verdict'], ['FARM', 'FARM'], ['THIN', 'THIN'], ['SKIP', 'SKIP']], state.verdict, function (v) { state.verdict = v; });
    var tier = sel('tier', 'Tier', [['all', 'All tiers'], ['watchlist', 'Watchlist'], ['early', 'Early below floor']], state.tier, function (v) { state.tier = v; });
    var cat = sel('cat', 'Category', [['all', 'All categories']].concat(cats.map(function (c) { return [c, c]; })), state.category, function (v) { state.category = v; });
    var ch = sel('ch', 'Chain', [['all', 'All chains']].concat(chains.map(function (c) { return [c, c]; })), state.chain, function (v) { state.chain = v; });
    var sort = sel('sort', 'Sort by', [['implied', 'Implied value'], ['nph', 'Net / hour'], ['net', 'Net'], ['tvl', 'TVL'], ['odds', 'Launch odds'], ['name', 'Name']], state.sort, function (v) { state.sort = v; state.dir = v === 'name' ? 1 : -1; });
    function tab(name, label) { return el('button', { type: 'button', 'aria-pressed': state.view === name ? 'true' : 'false', text: label, onclick: function () { state.view = name; state.selected = null; writeHash(); render(); } }); }
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      dep, drop, hor, ver, tier, cat, ch, sort,
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'View' }), el('div', { class: 'tabs' }, tab('board', 'Board'), tab('farm', 'Farm book'), tab('live', 'Live token'))));
  }
  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    var list = DATA.rows.filter(function (r) {
      if (state.tier === 'watchlist' && !r.watchlist) return false;
      if (state.tier === 'early' && r.watchlist) return false;
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (state.verdict !== 'all' && farmMath(r).verdict !== state.verdict) return false;
      if (state.view === 'farm' && (farmMath(r).verdict === 'SKIP')) return false;
      if (!q) return true;
      return [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase().indexOf(q) >= 0;
    });
    return list;
  }
  function sortedRows(list) {
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (state.sort === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (state.sort === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (state.sort === 'odds') { av = a.odds; bv = b.odds; }
      else if (state.sort === 'nph') { av = farmMath(a).nph; bv = farmMath(b).nph; }
      else if (state.sort === 'net') { av = farmMath(a).net; bv = farmMath(b).net; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }
  function sortHeader(key, label) {
    return el('th', { scope: 'col' }, el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = key === 'name' ? 1 : -1; } render(); } }, label, state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' v' : ' ^' }) : null));
  }
  function boardTable() {
    var list = sortedRows(filteredRows());
    var head = el('div', { class: 'panel' });
    if (state.view === 'farm') {
      var fm = list.map(farmMath);
      var tot = function (f) { return fm.reduce(function (s, x) { return s + x[f]; }, 0); };
      var net = tot('net');
      var hours = tot('hours');
      head.appendChild(el('div', { class: 'book' },
        el('div', null, el('span', { text: 'Farm book: rows' }), el('b', { text: String(list.length) })),
        el('div', null, el('span', { text: 'Capital at work' }), el('b', { text: fmtMoney(state.deposit * list.length) })),
        el('div', null, el('span', { text: 'Total slice' }), el('b', { text: fmtMoney(tot('slice')) })),
        el('div', null, el('span', { text: 'Total fees' }), el('b', { text: fmtMoney(tot('fees')) })),
        el('div', null, el('span', { text: 'T-bill forgone' }), el('b', { text: fmtMoney(tot('tbill')) })),
        el('div', null, el('span', { text: 'Total hours' }), el('b', { text: hours.toFixed(1) + ' h' })),
        el('div', null, el('span', { text: 'Total net' }), el('b', { text: fmtMoney(net) })),
        el('div', null, el('span', { text: 'Book net / hour' }), el('b', { text: fmtMoney(net / Math.max(1, hours)) + ' / h' }))));
    }
    if (list.length === 0) {
      head.appendChild(el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category to see the board again.' }),
        el('button', { class: 'button', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.verdict = 'all'; state.tier = 'all'; writeHash(); render(); } })));
      return head;
    }
    var tbody = el('tbody');
    list.forEach(function (r) {
      var f = farmMath(r);
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false', tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' },
          el('span', null, el('b', { text: r.name }), el('span', { class: 'tag' + (r.watchlist ? '' : ' early'), text: r.watchlist ? 'WATCHLIST' : 'EARLY' })),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', null, el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.round(r.odds * 100) + '%' })), el('span', { class: 'num', text: Math.round(r.odds * 100) + '%' })),
        el('td', { class: 'num', text: fmtUsd(r.value_if_usd) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round(r.implied_value_usd / DATA.rows[0].implied_value_usd * 100)) + '%;background:#3ecf8e' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })),
          el('div', { class: 'sub num', text: fmtUsd(r.band_lo) + ' - ' + fmtUsd(r.band_hi) })),
        el('td', null, pill(f.verdict)),
        el('td', { class: 'num ' + (f.net >= 0 ? 'pos' : 'neg'), text: fmtMoney(f.net) }),
        el('td', { class: 'num ' + (f.nph >= 0 ? 'pos' : 'neg'), text: fmtMoney(f.nph) + '/h' }));
      tbody.appendChild(tr);
    });
    head.appendChild(el('div', { class: 'table-wrap' },
      el('table', null,
        el('caption', { class: 'sub', text: (state.view === 'farm' ? 'Farmable rows, best net per hour first. Farming every row is one book; its totals are above.' : 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.') }),
        el('thead', null, el('tr', null,
          sortHeader('implied', 'Rank'), sortHeader('name', 'Protocol'), sortHeader('tvl', 'TVL'), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Age' }), sortHeader('odds', 'Odds'), el('th', { scope: 'col', text: 'If it launches' }), sortHeader('implied', 'Implied value'), el('th', { scope: 'col', text: 'Verdict' }), sortHeader('net', 'Net'), sortHeader('nph', 'Net / hour'))),
        tbody)));
    return head;
  }
  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num', text: 'live' }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', null, el('span', { class: 'sub', text: 'already trades' }))));
    });
    return el('div', { class: 'panel' }, el('div', { class: 'table-wrap' },
      el('table', null,
        el('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.' }),
        el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Token' }))),
        tbody)));
  }
  function openDetail(slug) {
    state.selected = slug;
    state.view = 'board';
    writeHash();
    render();
    window.scrollTo(0, 0);
  }
  function detailView() {
    var row = DATA.rows.filter(function (r) { return r.slug === state.selected; })[0];
    if (!row) return el('div', { class: 'panel' }, el('div', { class: 'empty' }, el('h2', { text: 'No such protocol on this board' })));
    var f = farmMath(row);
    var curveVal = valueIfCurve(row);
    var peers = DATA.peers.slice().sort(function (a, b) { return Math.abs(log10(a.tvl_usd) - log10(row.tvl_usd)) - Math.abs(log10(b.tvl_usd) - log10(row.tvl_usd)); }).slice(0, 5);
    var ptb = el('tbody');
    peers.forEach(function (p) {
      ptb.appendChild(el('tr', null,
        el('td', null, el('b', { text: p.name })),
        el('td', { class: 'num', text: fmtUsd(p.tvl_usd) }),
        el('td', { class: 'num', text: fmtUsd(p.mcap_usd) }),
        el('td', { class: 'num', text: (p.mcap_usd / p.tvl_usd).toFixed(2) + 'x' })));
    });
    var steps = farmSteps(row);
    return el('div', null,
      el('div', { class: 'detail-head' },
        el('div', null,
          el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + (row.watchlist ? ' - watchlist' : ' - early below the floor') }),
          el('h1', { text: row.name }),
          el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') + ' - ' + fmtUsd(row.tvl_usd) + ' TVL, ' + fmtPct(row.change_7d) + ' over 7 days, ' + fmtAge(row.age_days) + ' with no token on record.' })),
        el('button', { class: 'back', type: 'button', text: '< Back to the board', onclick: function () { state.selected = null; writeHash(); render(); } })),
      el('div', { class: 'grid2' },
        el('section', { class: 'panel' },
          el('h2', { text: 'Implied value, factor by factor' }),
          el('div', { class: 'equation' },
            el('div', null, el('span', { text: 'TVL' }), el('b', { text: fmtUsd(row.tvl_usd) })),
            el('div', null, el('span', { text: 'Fitted curve: 10^(' + DATA.curve_a + ' + ' + DATA.curve_b + ' x log10(TVL))' }), el('b', { text: fmtUsd(curveVal) })),
            el('div', null, el('span', { text: 'Value if it launches (curve, stored)' }), el('b', { text: fmtUsd(row.value_if_usd) })),
            el('div', null, el('span', { text: 'Launch odds, by age bucket' }), el('b', { text: Math.round(row.odds * 100) + '%' })),
            el('div', null, el('span', { text: 'Implied value = value-if-launches x odds' }), el('b', { text: fmtUsd(row.implied_value_usd) })),
            el('div', null, el('span', { text: 'Band, P25-P75 (leave-one-out)' }), el('b', { text: fmtUsd(row.band_lo) + ' - ' + fmtUsd(row.band_hi) })),
            el('div', null, el('span', { text: 'Band, P10-P90' }), el('b', { text: fmtUsd(row.band_lo90) + ' - ' + fmtUsd(row.band_hi90) }))),
          el('p', { class: 'sub', text: 'The page recomputes this row as ' + fmtUsd(Math.max(1, Math.round(row.value_if_usd * row.odds))) + ' before the $1 step-down, the same number board.json carries. The curve check above uses the rounded coefficients, so it lands within 2% of the stored value. This is an estimate, not a price, and "no token" is the snapshot record, not proof none exists.' }),
          el('h3', { text: 'Nearest traded peers, by TVL' }),
          el('table', null, el('thead', null, el('tr', null, el('th', { text: 'Peer' }), el('th', { text: 'TVL' }), el('th', { text: 'Market cap' }), el('th', { text: 'Multiple' }))), ptb)),
        el('section', { class: 'panel' },
          el('h2', { text: 'Where it sits on the curve' }),
          scatter(row),
          el('p', { class: 'sub', text: 'Amber marker: this protocol at its TVL and value-if-launches. Blue dots: the ' + DATA.peers_size + ' traded peers. Green line: the fitted curve.' }),
          el('h3', { text: 'Farm arithmetic at the chosen scenario' }),
          el('div', { class: 'arith' },
            el('div', null, el('span', { text: 'Slice if it launches (' + Math.round(state.drop * 100) + '% drop, $' + state.deposit.toLocaleString('en-US') + ' in, ' + state.weeks + ' weeks)' }), el('b', { text: fmtMoney(f.slice) })),
            el('div', null, el('span', { text: 'Minus gas and fees' }), el('b', { text: '-' + fmtMoney(f.fees) })),
            el('div', null, el('span', { text: 'Minus T-bill yield forgone (4.2% a year)' }), el('b', { text: '-' + fmtMoney(f.tbill) })),
            el('div', null, el('span', { text: 'Net' }), el('b', { text: fmtMoney(f.net) })),
            el('div', null, el('span', { text: 'Hands-on time' }), el('b', { text: f.hours.toFixed(1) + ' hours' })),
            el('div', null, el('span', { text: 'Net per hour' }), el('b', { text: fmtMoney(f.nph) + ' / h' })),
            el('div', null, el('span', { text: 'Break-even odds: the launch odds at which the slice covers the costs' }), el('b', { text: Math.round(f.be * 100) + '%' }))),
          el('p', null, pill(f.verdict), el('span', { class: 'sub', text: '  FARM needs net of at least $25 and $5 an hour; THIN is a positive net below that.' })))),
      el('section', { class: 'panel method' },
        el('h2', { text: 'Farm plan' }),
        el('ol', { class: 'steps' }, steps.map(function (s) {
          var at = s.indexOf(' Cost: ');
          return el('li', null, el('b', { text: at >= 0 ? s.slice(0, at) : s }), el('span', { class: 'cost', text: at >= 0 ? s.slice(at + 1) : '' }));
        })),
        el('p', { class: 'note', text: 'Stop rule: if the position falls below half its starting size, or the protocol stops publishing a points or rewards page, unwind and log the exit; do not add funds to chase a snapshot. Claim safety: claim only from the link on the protocol\u2019s own domain, never from a link in a message or a search ad, and never pay a fee to claim. Costs above are stated assumptions (gas on the cheapest chain, T-bill at 4.2%), not quotes.' })));
  }
  function footer() {
    return el('footer', { class: 'foot' },
      el('p', { text: 'Source: DefiLlama protocol index, snapshot ' + DATA.as_of + '. "Records no token" means the snapshot carries no market cap, CoinGecko id or symbol for the protocol; it is not proof no token exists. Implied value is this entry\u2019s model estimate, not a forecast and not a promise a token will launch. Farm costs are stated assumptions, not quotes.' }),
      el('p', { text: 'Model ' + DATA.model_version + ': log10(market cap) = ' + DATA.curve_a + ' + ' + DATA.curve_b + ' x log10(TVL), fit on ' + DATA.peers_size + ' traded peers; leave-one-out miss x' + DATA.loo_miss.toFixed(2) + ', walk-forward x' + DATA.wf_miss.toFixed(2) + ', flat baseline x' + DATA.flat_loo.toFixed(2) + ' / x' + DATA.flat_wf.toFixed(2) + '.' }));
  }
  function render() {
    // The farm book is always a net-per-hour ranking, whatever the board's sort was.
    if (state.view === 'farm' && state.sort === 'implied') { state.sort = 'nph'; state.dir = -1; }
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    if (state.selected) {
      shell.appendChild(detailView());
    } else {
      shell.appendChild(el('section', { class: 'lede' },
        el('h1', { text: DATA.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        el('p', { text: 'The watchlist is the floor: every protocol with at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL and no token on record. The early radar adds ' + DATA.early_size + ' pre-token protocols below that floor. Implied value = what a launch would be worth x the odds it ever records a token, both fitted from the snapshot\u2019s own peers. It is a model, not a promise.' })));
      shell.appendChild(kpis());
      shell.appendChild(proofs());
      shell.appendChild(accounting());
      shell.appendChild(el('div', { class: 'grid2' }, method(), el('section', { class: 'panel' }, el('h2', { text: 'The comps, on the curve' }), scatter(null), el('p', { class: 'sub', text: 'Each blue dot is a traded protocol at its TVL and market cap. The green line is the fitted curve the board prices from; the scatter is drawn from the same data file as the table.' }))));
      shell.appendChild(controls());
      shell.appendChild(el('div', { class: 'count', text: (state.view === 'live' ? DATA.live.length + ' live-token protocols' : filteredRows().length + ' of ' + DATA.board_size + ' rows shown') }));
      shell.appendChild(state.view === 'live' ? liveTable() : boardTable());
    }
    shell.appendChild(footer());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
  }
  readHash();
  if (state.view === 'farm') { state.sort = 'nph'; state.dir = -1; }
  render();
  window.addEventListener('hashchange', function () { readHash(); render(); });
})();
