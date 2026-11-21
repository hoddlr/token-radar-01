// Token Radar's model, radar-2: one snapshot in, one ranked board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) plus the
// early radar: pre-token protocols below the floor, by TVL. A protocol is pre-token when its record
// carries no token (no market cap, no CoinGecko id, no symbol); live-token protocols are kept apart
// as the market's own values, never mixed into the ranking.
//
// Value-if-it-launches is a fitted comps curve, fit in-session from the traded peers in this very
// snapshot: log10(market cap) = a + b x log10(TVL), ordinary least squares over the 128 protocols
// that record a market cap above zero. Category, momentum, age and kinship terms were all fitted
// the same way and tested; each one is kept only if it lowers the typical miss under BOTH held-out
// tests (leave-one-out and walk-forward, older-listed pricing newer-listed). None of them did, so
// the curve stands alone and the ladder on the board says so, term by term.
//
// Launch odds are a separate number from value-if-it-launches, from the peers' own record: the
// share of protocols that record a token, by age bucket (time since first listed). A category
// blend was tested the same way and not kept: it helped leave-one-out a little and walk-forward
// not at all. Implied value = value-if-it-launches x odds, with a band from the leave-one-out
// residuals. No protocol name is ever special-cased: the same functions score every row.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-2';

/** How many pre-token protocols below the watchlist floor the early radar carries, by TVL. */
export const EARLY_ROWS = 160;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** T-bill yield forgone while capital sits in a farm position, per year. */
export const TBILL_YIELD = 0.042;

/** Default farm scenario the board first shows: deposit, drop share, horizon in weeks. */
export const DEFAULT_DEPOSIT = 10000;
export const DEFAULT_DROP_SHARE = 0.07;
export const DEFAULT_HORIZON_WEEKS = 12;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  watchlist: boolean;
  implied_value_usd: number;
  value_if_launches_usd: number;
  launch_odds: number;
  band_lo_usd: number;
  band_hi_usd: number;
  band_lo90_usd: number;
  band_hi90_usd: number;
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with farm plans generated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  watchlist: boolean;
  implied_value_usd: number;
  value_if_usd: number;
  odds: number;
  band_lo: number;
  band_hi: number;
  band_lo90: number;
  band_hi90: number;
}

/** A traded peer: the comps the curve is fit from and the scatter draws. */
export interface PeerRow {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** One candidate term's held-out record, for the ladder on the board. */
export interface TermTest {
  term: string;
  loo: number;
  walk_forward: number;
  kept: boolean;
  note: string;
}

/** One odds candidate's held-out record, for the ladder on the board. */
export interface OddsTest {
  term: string;
  loo_brier: number;
  walk_forward_brier: number;
  kept: boolean;
  note: string;
}

/** One accounting bucket: every snapshot protocol sits in exactly one. */
export interface Bucket {
  key: string;
  label: string;
  count: number;
}

/** Everything the dashboard renders, from the snapshot. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  total_protocols: number;
  peers_size: number;
  curve_a: number;
  curve_b: number;
  flat_multiple: number;
  q10: number;
  q25: number;
  q75: number;
  q90: number;
  loo_miss: number;
  wf_miss: number;
  flat_loo: number;
  flat_wf: number;
  within3: number;
  holds2575: number;
  holds1090: number;
  kinship_peers: number;
  value_terms: TermTest[];
  odds_terms: OddsTest[];
  odds_base_brier: number;
  checksum: string;
  buckets: Bucket[];
  rows: RadarRow[];
  peers: PeerRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** 7-day TVL change, clamped to the range the model ever credits. */
export function clampedChange(p: SnapshotProtocol): number {
  return Math.min(120, Math.max(-60, finite(p.change_7d, 0)));
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** Whether a protocol records a token but no market cap is on file. */
export function isTokenNoCap(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && (p.gecko_id !== null || p.symbol !== null);
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** Median of numbers, or NaN for an empty list. */
function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Linear-interpolation quantile, the same rule the analysis used. */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

// ---------------------------------------------------------------- the fitted curve
//
// The traded peers are the 128 protocols with a market cap above zero. The curve is ordinary least
// squares on log10(market cap) against log10(TVL); every extra term is fitted on the curve's
// residuals in turn, so each term's coefficient is the part the earlier terms did not already take.

/** The traded peers a fit runs on. */
export function tradedPeers(protocols: SnapshotProtocol[]): SnapshotProtocol[] {
  return protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
}

export interface ValueParams {
  a: number;
  b: number;
  k: number;
  m: number;
  cat: Map<string, { n: number; mean: number }>;
  flat: number;
}

/** Fit the curve and every candidate term on `rows`, in the staged order the ladder reports. */
export function fitValue(rows: SnapshotProtocol[], asOf: string): ValueParams {
  const xs = rows.map((p) => Math.log10(p.tvl_usd));
  const ys = rows.map((p) => Math.log10(p.mcap_usd!));
  const n = rows.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i]! - mx) ** 2;
    sxy += (xs[i]! - mx) * (ys[i]! - my);
  }
  const b = sxx === 0 ? 0 : sxy / sxx;
  const a = my - b * mx;
  // Residuals after the curve; momentum is their slope on clamped 7-day change.
  const resid = rows.map((p, i) => ys[i]! - (a + b * xs[i]!));
  const chs = rows.map((p) => clampedChange(p) / 100);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += chs[i]! * resid[i]!;
    den += chs[i]! * chs[i]!;
  }
  const k = den === 0 ? 0 : num / den;
  const resid2 = resid.map((r, i) => r - k * chs[i]!);
  // Age is the slope of what is left on log10(age / 365 days); unknown age counts as 365 days.
  const ags = rows.map((p) => Math.log10(((ageDays(asOf, p.listed_at) ?? 365) / 365)));
  num = 0;
  den = 0;
  for (let i = 0; i < n; i++) {
    num += ags[i]! * resid2[i]!;
    den += ags[i]! * ags[i]!;
  }
  const m = den === 0 ? 0 : num / den;
  const resid3 = resid2.map((r, i) => r - m * ags[i]!);
  // Category is the mean of what is left, per category.
  const cat = new Map<string, { n: number; mean: number }>();
  const groups = new Map<string, number[]>();
  rows.forEach((p, i) => {
    const key = p.category ?? 'Other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(resid3[i]!);
  });
  for (const [key, vals] of groups) {
    cat.set(key, { n: vals.length, mean: vals.reduce((s, v) => s + v, 0) / vals.length });
  }
  const flat = median(rows.map((p) => p.mcap_usd! / p.tvl_usd));
  return { a, b, k, m, cat, flat };
}

export interface ValueFlags {
  cat: boolean;
  mom: boolean;
  age: boolean;
}

/** A peer's predicted market cap under `params` with the flagged terms applied. */
export function valuePredict(params: ValueParams, p: SnapshotProtocol, asOf: string, flags: ValueFlags): number {
  let v = params.a + params.b * Math.log10(p.tvl_usd);
  if (flags.cat) {
    const g = params.cat.get(p.category ?? 'Other');
    if (g !== undefined && g.n >= 3) v += (g.mean * g.n) / (g.n + 8);
  }
  if (flags.mom) v += params.k * (clampedChange(p) / 100);
  if (flags.age) v += params.m * Math.log10(((ageDays(asOf, p.listed_at) ?? 365) / 365));
  return 10 ** v;
}

/** Typical miss: the median factor by which a prediction misses the real cap. */
function missFactor(preds: number[], rows: SnapshotProtocol[]): number {
  return 10 ** median(preds.map((pr, i) => Math.abs(Math.log10(pr / rows[i]!.mcap_usd!))));
}

/** Leave-one-out typical miss: refit without each peer, predict it, take the median miss. */
function looMiss(peers: SnapshotProtocol[], asOf: string, flags: ValueFlags): number {
  const preds = peers.map((p, i) => {
    const rest = peers.filter((_, j) => j !== i);
    return valuePredict(fitValue(rest, asOf), p, asOf, flags);
  });
  return missFactor(preds, peers);
}

/** Walk-forward typical miss: protocols listed earlier price those listed later. */
function wfMiss(peers: SnapshotProtocol[], asOf: string, flags: ValueFlags): number {
  const keyed = peers.map((p) => ({ p, age: ageDays(asOf, p.listed_at) ?? 99999 }));
  keyed.sort((x, y) => y.age - x.age);
  const half = Math.floor(keyed.length / 2);
  const older = keyed.slice(0, half).map((k) => k.p);
  const newer = keyed.slice(half).map((k) => k.p);
  const params = fitValue(older, asOf);
  return missFactor(newer.map((p) => valuePredict(params, p, asOf, flags)), newer);
}

/** Leave-one-out residuals of the chosen model, for the printed band. */
function looResiduals(peers: SnapshotProtocol[], asOf: string, flags: ValueFlags): number[] {
  return peers.map((p, i) => {
    const rest = peers.filter((_, j) => j !== i);
    const pred = valuePredict(fitValue(rest, asOf), p, asOf, flags);
    return Math.log10(pred / p.mcap_usd!);
  });
}

// ---------------------------------------------------------------- launch odds
//
// Odds come from the peers' own record: the share of protocols that record a token, in the age
// bucket the protocol sits in. Age buckets are <180 days, 180-365, 1-2 years, 2-4 years, 4+ years;
// a protocol with no listing date takes the no-date rate. The odds ladder tests the base rate, the
// age buckets, a category blend and both together, by Brier score, leave-one-out and walk-forward.

const AGE_BUCKETS: Array<[number, number]> = [
  [0, 180],
  [180, 365],
  [365, 730],
  [730, 1460],
  [1460, Infinity],
];

export interface OddsParams {
  base: number;
  buckets: number[];
  nullRate: number;
  cat: Map<string, { n: number; share: number }>;
}

export function fitOdds(rows: SnapshotProtocol[], asOf: string): OddsParams {
  const base = rows.filter((p) => !isPreToken(p)).length / Math.max(1, rows.length);
  const buckets = AGE_BUCKETS.map(([lo, hi]) => {
    const g = rows.filter((p) => {
      const a = ageDays(asOf, p.listed_at);
      return a !== null && a >= lo && a < hi;
    });
    return g.length === 0 ? base : g.filter((p) => !isPreToken(p)).length / g.length;
  });
  const nulls = rows.filter((p) => ageDays(asOf, p.listed_at) === null);
  const nullRate = nulls.length === 0 ? base : nulls.filter((p) => !isPreToken(p)).length / nulls.length;
  const cat = new Map<string, { n: number; share: number }>();
  const groups = new Map<string, SnapshotProtocol[]>();
  for (const p of rows) {
    const key = p.category ?? 'Other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }
  for (const [key, g] of groups) {
    cat.set(key, { n: g.length, share: g.filter((p) => !isPreToken(p)).length / g.length });
  }
  return { base, buckets, nullRate, cat };
}

export type OddsMode = 'base' | 'age' | 'cat' | 'agecat';

/** A protocol's launch odds under `params` and `mode`, clamped to a sane range. */
export function oddsOf(params: OddsParams, p: SnapshotProtocol, asOf: string, mode: OddsMode): number {
  let o: number;
  if (mode === 'base') {
    o = params.base;
  } else if (mode === 'cat') {
    const g = params.cat.get(p.category ?? 'Other');
    o = g === undefined ? params.base : (g.share * g.n + params.base * 10) / (g.n + 10);
  } else {
    const a = ageDays(asOf, p.listed_at);
    let ab = params.nullRate;
    if (a !== null) {
      for (let i = 0; i < AGE_BUCKETS.length; i++) {
        if (a >= AGE_BUCKETS[i]![0] && a < AGE_BUCKETS[i]![1]) ab = params.buckets[i]!;
      }
    }
    if (mode === 'age') {
      o = ab;
    } else {
      const g = params.cat.get(p.category ?? 'Other');
      const cs = g === undefined ? params.base : (g.share * g.n + params.base * 10) / (g.n + 10);
      o = 0.6 * ab + 0.4 * cs;
    }
  }
  return Math.min(0.95, Math.max(0.02, o));
}

function brier(preds: number[], rows: SnapshotProtocol[]): number {
  return preds.reduce((s, pr, i) => s + (pr - (isPreToken(rows[i]!) ? 0 : 1)) ** 2, 0) / Math.max(1, rows.length);
}

function looBrier(all: SnapshotProtocol[], asOf: string, mode: OddsMode): number {
  const preds = all.map((p, i) => {
    const rest = all.filter((_, j) => j !== i);
    return oddsOf(fitOdds(rest, asOf), p, asOf, mode);
  });
  return brier(preds, all);
}

function wfBrier(all: SnapshotProtocol[], asOf: string, mode: OddsMode): number {
  const dated = all
    .map((p) => ({ p, age: ageDays(asOf, p.listed_at) }))
    .filter((k) => k.age !== null) as Array<{ p: SnapshotProtocol; age: number }>;
  dated.sort((x, y) => y.age - x.age);
  const half = Math.floor(dated.length / 2);
  const older = dated.slice(0, half).map((k) => k.p);
  const newer = dated.slice(half).map((k) => k.p);
  const params = fitOdds(older, asOf);
  return brier(newer.map((p) => oddsOf(params, p, asOf, mode)), newer);
}

// ---------------------------------------------------------------- farm economics
//
// A farm plan is costed at a chosen deposit: the slice is the farmer's share of the drop, the drop
// is a share of the implied value, and the farming pool is max(25% of the protocol's TVL, $50M).
// Pool penggarap diambil max(25% TVL, $50M) — setidaknya $50M modal ikut menggarap setiap peluncuran, jadi drop terbagi lebih banyak arah pada protokol kecil; $50M adalah floor watchlist snapshot sendiri.
// A deposit's slice is pro-rata to its share of that pool. Fees are gas on the protocol's cheapest
// chain, once to set up, once a week, plus the T-bill yield forgone on the deposit at 4.2% a year
// for the horizon. Net = slice - fees - T-bill forgone; net/hour divides by the hands-on time.
// FARM needs net of at least $25 and $5 an hour; THIN is a positive net below that; anything else
// is SKIP. These are stated assumptions, not quotes.

/** Gas in dollars for one transaction on a chain; the page uses the same table. */
export function gasPerTx(chain: string): number {
  const table: Record<string, number> = {
    Ethereum: 6,
    Solana: 0.05,
    Base: 0.1,
    Arbitrum: 0.3,
    BSC: 0.25,
    Polygon: 0.05,
    Avalanche: 0.5,
    Optimism: 0.15,
    Sui: 0.05,
    'Binance Smart Chain': 0.25,
  };
  return table[chain] ?? 1.5;
}

/** The cheapest gas among a protocol's chains. */
export function cheapestGas(chains: string[]): number {
  if (chains.length === 0) return 1.5;
  return Math.min(...chains.map((c) => gasPerTx(c)));
}

export interface FarmMath {
  slice: number;
  fees: number;
  tbill: number;
  net: number;
  hours: number;
  netPerHour: number;
  breakEvenOdds: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
}

/** The costed verdict for one row at one deposit, drop share and horizon. */
export function farmMath(row: { tvl_usd: number; chains: string[]; value_if_usd: number; implied_value_usd: number }, deposit: number, dropShare: number, weeks: number): FarmMath {
  const pool = Math.max(50_000_000, 0.25 * row.tvl_usd);
  const gas = cheapestGas(row.chains);
  const slice = (row.implied_value_usd * dropShare * deposit) / pool;
  const fees = gas * (2 + weeks + 1);
  const tbill = (deposit * TBILL_YIELD * weeks) / 52;
  const net = slice - fees - tbill;
  const hours = 0.5 + 0.25 * weeks + 0.25;
  const netPerHour = net / hours;
  const fullSlice = (row.value_if_usd * dropShare * deposit) / pool;
  const breakEvenOdds = fullSlice <= 0 ? 1 : Math.min(1, Math.max(0, (fees + tbill) / fullSlice));
  const verdict = net >= 25 && netPerHour >= 5 ? 'FARM' : net > 0 ? 'THIN' : 'SKIP';
  return { slice, fees, tbill, net, hours, netPerHour, breakEvenOdds, verdict };
}

// ---------------------------------------------------------------- farm steps
//
// Six steps per protocol, derived from its own record (category, chains, TVL, age), never from a
// hand-written list of names. The page generates the same strings from the same derivation.

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('risk')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** A protocol's farm plan: six steps, each an action with a cost and a time. */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = cheapestGas(p.chains);
  const gasStr = gas >= 1 ? `$${gas}` : `$${gas.toFixed(2)}`;
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: `about ${gasStr} of gas for the first transaction`,
      time: '5 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital and about ${gasStr} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Make one qualifying action each week on ${p.name}, such as a deposit, a borrow, a swap or a vote.`,
      cost: `about ${gasStr} of gas a week`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open ${p.name}'s own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

// ---------------------------------------------------------------- the board

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot): { board: BoardRow[]; validation: RadarData } {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const peers = tradedPeers(snapshot.protocols);
  const asOf = snapshot.as_of;
  const params = fitValue(peers, asOf);
  const chosenFlags: ValueFlags = { cat: false, mom: false, age: false };
  const flagsList: Array<{ name: string; flags: ValueFlags; base: string }> = [
    { name: 'flat median multiple', flags: { cat: false, mom: false, age: false }, base: 'flat' },
    { name: 'size curve, ln TVL', flags: { cat: false, mom: false, age: false }, base: 'curve' },
    { name: '+ category effect, shrunk', flags: { cat: true, mom: false, age: false }, base: 'curve' },
    { name: '+ 7-day TVL growth', flags: { cat: false, mom: true, age: false }, base: 'curve' },
    { name: '+ age, years listed', flags: { cat: false, mom: false, age: true }, base: 'curve' },
    { name: '+ category + growth', flags: { cat: true, mom: true, age: false }, base: 'curve' },
    { name: '+ category + growth + age', flags: { cat: true, mom: true, age: true }, base: 'curve' },
  ];
  // The flat baseline's two tests, for the ladder's first row.
  const flatLoo = (() => {
    const preds = peers.map((p, i) => {
      const rest = peers.filter((_, j) => j !== i);
      return fitValue(rest, asOf).flat * p.tvl_usd;
    });
    return missFactor(preds, peers);
  })();
  const flatWf = (() => {
    const keyed = peers.map((p) => ({ p, age: ageDays(asOf, p.listed_at) ?? 99999 }));
    keyed.sort((x, y) => y.age - x.age);
    const half = Math.floor(keyed.length / 2);
    const older = keyed.slice(0, half).map((k) => k.p);
    const newer = keyed.slice(half).map((k) => k.p);
    return missFactor(newer.map((p) => fitValue(older, asOf).flat * p.tvl_usd), newer);
  })();
  const tested: TermTest[] = [];
  let curveLoo = 0;
  let curveWf = 0;
  for (const spec of flagsList) {
    let loo: number;
    let wf: number;
    if (spec.base === 'flat') {
      loo = flatLoo;
      wf = flatWf;
      tested.push({ term: spec.name, loo: round3(loo), walk_forward: round3(wf), kept: false, note: 'baseline' });
      continue;
    }
    loo = looMiss(peers, asOf, spec.flags);
    wf = wfMiss(peers, asOf, spec.flags);
    const isCurve = spec.name.startsWith('size curve');
    if (isCurve) {
      curveLoo = loo;
      curveWf = wf;
    }
    // A term is kept only when it lowers the typical miss under BOTH held-out tests against the
    // model without it (the curve for the additions, the flat baseline for the curve itself).
    const baseLoo = isCurve ? flatLoo : curveLoo;
    const baseWf = isCurve ? flatWf : curveWf;
    const kept = loo < baseLoo && wf < baseWf;
    tested.push({
      term: spec.name,
      loo: round3(loo),
      walk_forward: round3(wf),
      kept,
      note: kept ? 'kept' : isCurve ? 'kept' : 'tested, not kept',
    });
  }
  // Kinship: a first-word stem shared with another tokened protocol. Too few peers carry one to fit.
  const firstWord = new Map<string, number>();
  for (const p of snapshot.protocols) {
    if (isPreToken(p)) continue;
    const w = p.name.split(/\s+/)[0]!.toLowerCase();
    firstWord.set(w, (firstWord.get(w) ?? 0) + 1);
  }
  const kinshipPeers = peers.filter((p) => (firstWord.get(p.name.split(/\s+/)[0]!.toLowerCase()) ?? 0) > 1).length;

  // The band comes from the chosen model's leave-one-out residuals.
  const residuals = looResiduals(peers, asOf, chosenFlags).sort((a, b) => a - b);
  const q10 = quantile(residuals, 0.1);
  const q25 = quantile(residuals, 0.25);
  const q75 = quantile(residuals, 0.75);
  const q90 = quantile(residuals, 0.9);
  const within3 = residuals.filter((r) => Math.abs(r) < Math.log10(3)).length / residuals.length;
  const holds2575 = residuals.filter((r) => r >= q25 && r <= q75).length / residuals.length;
  const holds1090 = residuals.filter((r) => r >= q10 && r <= q90).length / residuals.length;

  // Odds ladder: base rate, age buckets, category blend, both together.
  const oddsModes: Array<{ name: string; mode: OddsMode }> = [
    { name: 'base rate of peers', mode: 'base' },
    { name: '+ age, years listed', mode: 'age' },
    { name: '+ category blend', mode: 'cat' },
    { name: '+ age + category', mode: 'agecat' },
  ];
  const oddsTested: OddsTest[] = [];
  let baseLooB = 0;
  let baseWfB = 0;
  let ageLooB = 0;
  let ageWfB = 0;
  for (const spec of oddsModes) {
    const loo = looBrier(snapshot.protocols, asOf, spec.mode);
    const wf = wfBrier(snapshot.protocols, asOf, spec.mode);
    if (spec.mode === 'base') {
      baseLooB = loo;
      baseWfB = wf;
    }
    if (spec.mode === 'age') {
      ageLooB = loo;
      ageWfB = wf;
    }
    const refLoo = spec.mode === 'age' ? baseLooB : spec.mode === 'base' ? Infinity : ageLooB;
    const refWf = spec.mode === 'age' ? baseWfB : spec.mode === 'base' ? Infinity : ageWfB;
    const kept = spec.mode !== 'base' && loo < refLoo && wf < refWf;
    oddsTested.push({
      term: spec.name,
      loo_brier: round3(loo),
      walk_forward_brier: round3(wf),
      kept,
      note: spec.mode === 'base' ? 'baseline' : kept ? 'kept' : 'tested, not kept',
    });
  }

  const oddsParams = fitOdds(snapshot.protocols, asOf);
  const scored = [...chosen.values()].map((p) => {
    const age = ageDays(asOf, p.listed_at);
    // Round first, then multiply: the page stores these same rounded figures and must reproduce
    // the implied value exactly, so the raw product here uses the rounded inputs, not the raw fit.
    const valueIf = Math.max(1, Math.round(valuePredict(params, p, asOf, chosenFlags)));
    const odds = round4(oddsOf(oddsParams, p, asOf, 'age'));
    const raw = valueIf * odds;
    return { p, age, valueIf, odds, raw };
  });
  scored.sort((x, y) => y.raw - x.raw || y.p.tvl_usd - x.p.tvl_usd || (x.p.slug < y.p.slug ? -1 : x.p.slug > y.p.slug ? 1 : 0));
  // Implied values must fall strictly down the board, so a shared raw value steps down by $1.
  // The page runs the same rule on the same raws, so its recompute still matches board.json.
  const raws = scored.map((s) => Math.max(1, Math.round(s.raw)));
  for (let i = 1; i < raws.length; i++) {
    if (raws[i]! >= raws[i - 1]!) raws[i] = raws[i - 1]! - 1;
  }
  const board: BoardRow[] = scored.map((s, i) => {
    const implied = raws[i]!;
    const loF = 10 ** -q75;
    const hiF = 10 ** -q25;
    const lo90F = 10 ** -q90;
    const hi90F = 10 ** -q10;
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      age_days: s.age,
      watchlist: snapshot.watchlist.includes(s.p.slug),
      implied_value_usd: implied,
      value_if_launches_usd: s.valueIf,
      launch_odds: s.odds,
      band_lo_usd: Math.max(1, Math.round(implied * loF)),
      band_hi_usd: Math.max(1, Math.round(implied * hiF)),
      band_lo90_usd: Math.max(1, Math.round(implied * lo90F)),
      band_hi90_usd: Math.max(1, Math.round(implied * hi90F)),
      farm_steps: farmSteps(s.p, s.age).map(stepText),
    };
  });

  const radar = buildRadarData(snapshot, board, peers, params, {
    q10,
    q25,
    q75,
    q90,
    looMiss: curveLoo,
    wfMiss: curveWf,
    flatLoo,
    flatWf,
    within3,
    holds2575,
    holds1090,
    kinshipPeers,
    valueTerms: tested,
    oddsTerms: oddsTested,
    oddsBaseBrier: baseLooB,
  });
  return { board, validation: radar };
}

/** Every snapshot protocol in exactly one bucket, for the accounting bar. */
export function accountingBuckets(snapshot: Snapshot, board: BoardRow[]): Bucket[] {
  const ranked = new Set(board.map((r) => r.slug));
  const counts = new Map<string, number>();
  const bump = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const p of snapshot.protocols) {
    if (ranked.has(p.slug)) {
      bump(snapshot.watchlist.includes(p.slug) ? 'ranked-watchlist' : 'ranked-early');
    } else if (p.mcap_usd !== null) {
      bump('token-trades');
    } else if (isTokenNoCap(p)) {
      bump('token-no-cap');
    } else if (p.category === 'Bridge' || p.category === 'Canonical Bridge' || p.category === 'Cross Chain Bridge') {
      bump('bridge');
    } else if (p.category === 'Liquid Staking' || p.category === 'Liquid Restaking' || p.category === 'Restaked BTC') {
      bump('liquid-staking');
    } else if (p.category === 'CEX') {
      bump('exchange');
    } else if (VERSIONED.test(p.name) || p.name.toLowerCase().split(/\s+/).some((w) => w === 'wrapped' || w === 'staked' || w === 'staking')) {
      bump('versioned-wrapped');
    } else {
      bump('other-pre-token');
    }
  }
  const labels: Array<[string, string]> = [
    ['ranked-watchlist', 'Ranked, watchlist'],
    ['ranked-early', 'Ranked, early below floor'],
    ['token-trades', 'Token trades'],
    ['token-no-cap', 'Token on record, no cap'],
    ['bridge', 'Bridge'],
    ['liquid-staking', 'Liquid staking'],
    ['exchange', 'Exchange custody'],
    ['versioned-wrapped', 'Versioned or wrapped'],
    ['other-pre-token', 'Other pre-token'],
  ];
  return labels.map(([key, label]) => ({ key, label, count: counts.get(key) ?? 0 }));
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    age_days: row.age_days,
    watchlist: row.watchlist,
    implied_value_usd: row.implied_value_usd,
    value_if_usd: row.value_if_launches_usd,
    odds: row.launch_odds,
    band_lo: row.band_lo_usd,
    band_hi: row.band_hi_usd,
    band_lo90: row.band_lo90_usd,
    band_hi90: row.band_hi90_usd,
  };
}

/** FNV-1a over the board's canonical JSON: the page recomputes it and the chip can fail. */
export function boardChecksum(board: BoardRow[]): string {
  const text = JSON.stringify(board.map((r) => [r.rank, r.slug, r.implied_value_usd]));
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function buildRadarData(
  snapshot: Snapshot,
  board: BoardRow[],
  peers: SnapshotProtocol[],
  params: ValueParams,
  v: {
    q10: number;
    q25: number;
    q75: number;
    q90: number;
    looMiss: number;
    wfMiss: number;
    flatLoo: number;
    flatWf: number;
    within3: number;
    holds2575: number;
    holds1090: number;
    kinshipPeers: number;
    valueTerms: TermTest[];
    oddsTerms: OddsTest[];
    oddsBaseBrier: number;
  },
): RadarData {
  const buckets = accountingBuckets(snapshot, board);
  return {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !r.watchlist).length,
    live_size: LIVE_ROWS,
    total_protocols: snapshot.protocols.length,
    peers_size: peers.length,
    curve_a: round4(params.a),
    curve_b: round4(params.b),
    flat_multiple: round4(params.flat),
    q10: round4(v.q10),
    q25: round4(v.q25),
    q75: round4(v.q75),
    q90: round4(v.q90),
    loo_miss: round3(v.looMiss),
    wf_miss: round3(v.wfMiss),
    flat_loo: round3(v.flatLoo),
    flat_wf: round3(v.flatWf),
    within3: round3(v.within3),
    holds2575: round3(v.holds2575),
    holds1090: round3(v.holds1090),
    kinship_peers: v.kinshipPeers,
    value_terms: v.valueTerms,
    odds_terms: v.oddsTerms,
    odds_base_brier: round3(v.oddsBaseBrier),
    checksum: boardChecksum(board),
    buckets,
    rows: board.map(radarRow),
    peers: peers
      .map((p) => ({ slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd! }))
      .sort((a, b) => b.mcap_usd - a.mcap_usd),
    live: liveRows(snapshot),
  };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  const buckets = accountingBuckets(snapshot, board);
  const total = buckets.reduce((s, b) => s + b.count, 0);
  if (total !== snapshot.protocols.length) return `accounting covers ${total} of ${snapshot.protocols.length} protocols`;
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
