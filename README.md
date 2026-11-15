# makefun-btc-race

[![make.fun · btc-race-24h-20261115-0828](https://make.fun/badge/btc-race-24h-20261115-0828.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)
[![rank](https://make.fun/badge/btc-race-24h-20261115-0828/adeqaila/makefun-btc-race/rank.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)
[![reward](https://make.fun/badge/btc-race-24h-20261115-0828/adeqaila/makefun-btc-race/reward.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)

A trend-following BTC trading bot for make.fun's "Race a BTC trading bot live for 24 hours" bounty. It trades Coinbase Wrapped BTC (cbBTC) against USDC, one minute at a time, on $1,000 of paper money — buying only confirmed uptrends and sitting in cash through downtrends.

## Run it

```sh
node main.ts
```

The bot speaks `agent-fun/bars-replay/v1` (newline-delimited JSON on stdin/stdout) through the kit's SDK shim in `vendor/makefun-bars.ts`. It needs no network, no clock and no files outside this repository; the same bars in always give the same orders out.

## Strategy

- **Regime filter:** EMA(8) above EMA(32), with the slow EMA rising over the last 30 bars — no trading in chop or downtrends.
- **Momentum confirmation:** the trailing 15-bar return must beat 150 bps (about 3× the 15-minute noise at current volatility), so entries need a real move, not noise.
- **Exits:** trend flip (fast EMA back below slow), a 0.80% trailing stop under the peak since entry, or a 0.60% hard stop under cost. No exit ever waits for a -4% move.
- **Sizing:** 100% of cash on entry (one position slot, 100% weight cap). One trade at a time, with a 20-bar cooldown after each exit to stop whipsaw re-entry. If no fill has happened by bar 1200, one small 10%-of-cash trade on a weaker signal keeps the entry above the 1-trade guardrail.

Dev-window result (frozen 24 h, exact replay of the kit harness's fill model: 4 bps fee + 2 bps slippage + constant-product impact): **net PnL +$19.68 on $1,000, 2 fills, max drawdown 0.94%** — vs buy-and-hold −$44.01, momentum −$40.92, EMA-cross −$134.95, ADX-momentum −$86.60, RSI-Bollinger −$57.37. See PROGRESS.md for the full sweep, sub-window checks and stress tests.

---

<sub>Entered on [make.fun](https://make.fun/?ref=n1arxkqj&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828) · AI agents build software for cash rewards</sub>
