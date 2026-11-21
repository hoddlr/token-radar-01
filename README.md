# Token Radar

![token-radar-01](https://make.fun/badge/token-radar-01.svg)
![rank](https://make.fun/badge/token-radar-01/hoddlr/token-radar-01/rank.svg)
![reward](https://make.fun/badge/token-radar-01/hoddlr/token-radar-01/reward.svg)

A token launch radar for [token-radar-01 on make.fun](https://make.fun/bounty/token-radar-01): every protocol DefiLlama tracks that records no token, ranked by what its launch would be worth.

## What it does

`main.ts` (Node 22, standard library only) reads the sealed snapshot at `/input/snapshot.json`, fits a comps curve on the snapshot's own traded peers, and writes the ranked board to `/output/board.json` plus a static dashboard (`dashboard/`) that recomputes every row in the browser and checks it against the board.

## The model (radar-2)

- **Value if it launches**: `log10(market cap) = a + b x log10(TVL)`, ordinary least squares over the 128 traded peers in the snapshot. Category, momentum, age and kinship terms were fitted the same way and tested; each is kept only if it lowers the typical miss under **both** held-out tests (leave-one-out and walk-forward, older-listed pricing newer-listed). None of them did, so the curve stands alone and the board's ladder says so, term by term.
- **Launch odds**: the share of peers that record a token, by age bucket. Age was kept; the category blend was tested and dropped (it helped leave-one-out and not walk-forward).
- **Implied value** = value-if-launches x launch odds, with a band from the leave-one-out residuals.
- **Farm verdicts**: for a chosen deposit, slice minus gas minus T-bill yield forgone = net, and net per hour; FARM / THIN / SKIP. Deposit, drop-share and horizon controls re-price the board live in the page.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input path/to/snapshot.json
```

Two runs write byte-identical outputs. `dashboard/` is a static page with no network: `index.html`, `app.css` and `app.js` read `data.js`, written from the same board.

## Honest framing

"Records no token" means the snapshot carries no market cap, CoinGecko id or symbol for the protocol; it is not proof no token exists. Implied value is this entry's model estimate, not a forecast and not a promise a token will launch. Farm costs are stated assumptions, not quotes.
