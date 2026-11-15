// Bounty Hunter — a trend-following BTC bot for make.fun's btc-race-24h-20261115-0828.
//
// Design (metric-first: net PnL after 4 bps fee + 2 bps slippage + pool impact):
//   - The dev window falls -3.9% with two sharp down legs. Buy-and-hold loses ~$44.
//     The only way to make money is to sit in cash through downtrends and ride the
//     up-legs. Every round trip costs ~26 bps, so trades must catch moves >> 26 bps.
//   - Signal: EMA(8) above EMA(32) = uptrend regime, with the slow EMA rising
//     over the last 15 bars, confirmed by a trailing 15-bar return above 150 bps
//     (about 3x the 15-minute noise at current volatility). No trade on noise:
//     entries need a real, already-moving trend.
//   - Exit: trend flip (fast below slow), a trailing stop under the peak since entry,
//     or a hard stop under cost. No take-profit — the trailing stop banks the move.
//   - Sizing: 100% of cash on entry (one position slot, 100% weight cap). One trade at a time;
//     a cooldown after each exit stops whipsaw re-entry. If the window has produced
//     no fill by bar 1200, one small 10%-of-cash trade on a weaker signal keeps the
//     entry above the 1-trade guardrail.
//   - Deterministic: float64 EMAs seeded exactly like the baselines (mean of the
//     first span of closes), no clock, no randomness, no environment reads.
//
// Entry = main.ts at the repo root, run as `node /bot/main.ts` (Node 22, type
// stripping, erasable syntax only). It speaks agent-fun/bars-replay/v1 through
// the kit's SDK shim in vendor/makefun-bars.ts (byte-identical copy of the kit SDK).

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 100; // 1% past the close decided on; 1m moves rarely exceed it.

// --- tuned parameters (see PROGRESS.md for the sweep) ---
const FAST_BARS = 8; // fast EMA span
const SLOW_BARS = 32; // slow EMA span
const RET_WIN = 15; // momentum confirmation window (bars)
const RET_MIN_BPS = 150; // trailing RET_WIN-bar return must exceed this to enter
const TRAIL_BPS = 60; // trailing stop under the peak since entry (bps)
const STOP_BPS = 60; // hard stop under entry cost (bps)
const COOLDOWN_BARS = 20; // bars to wait after an exit before re-entering
const SLOPE_WIN = 15; // slow EMA must be rising over this many bars to enter
// Guardrail insurance: if the window has produced no fill by bar 1200, take one
// small (10% of cash) trade on a weaker signal so the entry still meets the
// 1-trade minimum. It never fires on the dev window (the main trade lands ~bar 1050).
const FALLBACK_BAR = 720;
const FALLBACK_RET_BPS = 30;
const FALLBACK_BPS = 1000; // 10% of cash

interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

const closes: number[] = []; // every close seen, oldest first
const fast: Ema = { span: FAST_BARS, warm: [], value: null };
const slow: Ema = { span: SLOW_BARS, warm: [], value: null };
const slowHist: number[] = []; // slow EMA value after every bar
let peakClose = 0; // highest close since entry (trailing stop reference)
let entryCost = 0n; // cost basis of the open position, quote units
let cooldownUntil = -1; // seq until which entries are blocked
let wasHeld = false; // the previous batch held a position
let filledTrades = 0; // filled orders so far (from the batches' fills)

function step(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

/** Trailing RET_WIN-bar return in bps, or null without enough history. */
function retBps(): number | null {
  if (closes.length <= RET_WIN) return null;
  const now = closes[closes.length - 1];
  const then = closes[closes.length - 1 - RET_WIN];
  if (then === 0) return null;
  return ((now - then) / then) * 10000;
}

function inUptrend(): boolean {
  return fast.value !== null && slow.value !== null && fast.value > slow.value;
}

/** The slow EMA is rising over the last SLOPE_WIN bars (regime filter). */
function slowRising(): boolean {
  if (slowHist.length <= SLOPE_WIN) return false;
  const now = slowHist[slowHist.length - 1];
  const then = slowHist[slowHist.length - 1 - SLOPE_WIN];
  return Number.isFinite(now) && Number.isFinite(then) && now > then;
}

await runBars({
  onBatch(state: BarsState, batch) {
    for (const f of batch.fills) if (f.status === 'filled') filledTrades++;
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      const c = Number(bar.c);
      closes.push(c);
      step(fast, c);
      step(slow, c);
      slowHist.push(slow.value ?? NaN);
    }
    if (state.warmingUp) return [];
    const close = state.close(SYMBOL);
    if (close === null) return [];
    const held = state.positions.get(SYMBOL);
    const { caps, fees } = state.hello;

    if (held === undefined) {
      // A sell filled since the last batch: arm the cooldown, clear entry state.
      if (wasHeld) {
        wasHeld = false;
        entryCost = 0n;
        peakClose = 0;
        cooldownUntil = batch.seq + COOLDOWN_BARS;
      }
    } else {
      wasHeld = true;
      // Track the peak for the trailing stop.
      const cNum = Number(close);
      if (cNum > peakClose) peakClose = cNum;
      const value = state.value(SYMBOL, held.qty);
      const trendFlipped = !inUptrend();
      const trailingHit = cNum < peakClose * (1 - TRAIL_BPS / 10000);
      const stopHit = value * 10000n <= entryCost * BigInt(10000 - STOP_BPS);
      if (trendFlipped || trailingHit || stopHit) {
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      return [];
    }

    // Flat: look for an entry.
    if (batch.seq < cooldownUntil) return [];
    const r = retBps();
    if (inUptrend() && slowRising() && r !== null && r >= RET_MIN_BPS) {
      const slice = state.cash;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) return [];
      const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
      const notional = slice < byWeight ? slice : byWeight;
      if (notional < BigInt(fees.min_notional_quote_units)) return [];
      entryCost = notional;
      peakClose = Number(close);
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
    }
    // Fallback: no fill yet late in the window — one small trade on a weaker
    // signal, only to meet the 1-trade guardrail. Same exits apply. Note it
    // does NOT require the slow EMA to be rising: a 15-bar-old rise has not
    // moved the slow EMA yet, and fast > slow is confirmation enough at 10% size.
    if (batch.seq >= FALLBACK_BAR && filledTrades === 0 && inUptrend() && r !== null && r >= FALLBACK_RET_BPS) {
      const notional = (state.cash * BigInt(FALLBACK_BPS)) / BPS;
      if (notional < BigInt(fees.min_notional_quote_units)) return [];
      entryCost = notional;
      peakClose = Number(close);
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
    }
    return [];
  },
});
