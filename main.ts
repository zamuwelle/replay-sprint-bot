import { LAMPORTS_PER_SOL, runBot } from './vendor/makefun-bot.ts';

const POSITION_SIZE = LAMPORTS_PER_SOL * 13n / 1_000n;
const MIN_FLOW = LAMPORTS_PER_SOL * 3n / 2n;
const curvesSeen = new Map<string, { owner: string; start: number; price: number; high: number; bought: bigint; sold: bigint; buyers: Set<string>; tradeCount: number; born: number; ownerSold: boolean }>();
const tried = new Set<string>();
let entryCount = 0;

function spot(quote: string, supply: string): number {
  return Number(BigInt(quote)) / Number(BigInt(supply));
}

await runBot({
  onBatch(state, batch) {
    const orders = [];
    for (const event of batch.events) {
      if (event.event === 'CreateEvent') {
        curvesSeen.set(event.mint, { owner: event.creator, start: spot(event.virtual_sol_reserves, event.virtual_token_reserves), price: 0, high: 0, bought: 0n, sold: 0n, buyers: new Set(), tradeCount: 0, born: event.slot, ownerSold: false });
        continue;
      }
      if (event.event !== 'TradeEvent') continue;
      const record = curvesSeen.get(event.mint);
      if (!record) continue;
      record.price = spot(event.virtual_sol_reserves, event.virtual_token_reserves);
      record.high = Math.max(record.high, record.price);
      record.tradeCount++;
      if (event.is_buy) {
        record.bought += BigInt(event.sol_amount);
        if (event.user !== record.owner) record.buyers.add(event.user);
      } else {
        record.sold += BigInt(event.sol_amount);
        if (event.user === record.owner) record.ownerSold = true;
      }
    }

    for (const [mint, position] of state.positions) {
      const record = curvesSeen.get(mint);
      const curve = state.curves.get(mint);
      const pendingExit = [...state.pending.values()].some((pending) => pending.order.side === 'sell' && pending.order.mint === mint);
      if (!record || !curve || curve.complete || pendingExit) continue;
      const offHigh = record.high > 0 ? record.price / record.high : 1;
      const returnMultiple = record.price / (Number(position.cost_lamports) / Number(position.token_amount));
      const pressure = record.sold > record.bought;
      const heldSlots = state.slot - record.born;
      if (record.ownerSold || offHigh < 0.76 || returnMultiple < 0.72 || (pressure && offHigh < 0.90) || heldSlots > 5_000) {
        orders.push({ side: 'sell', mint, token_amount: position.token_amount, max_slippage_bps: 10_000 });
      }
    }

    let available = state.freeCashLamports();
    const feeReserve = state.txFeeLamports();
    const room = state.hello.caps.max_open_positions - state.committedPositionCount();
    let buysSent = 0;
    for (const [mint, record] of curvesSeen) {
      if (buysSent >= room || entryCount >= 50 || orders.length >= state.hello.caps.max_orders_per_batch) break;
      const curve = state.curves.get(mint);
      if (tried.has(mint) || !curve || curve.complete || record.ownerSold || record.tradeCount < 10 || record.tradeCount > 90 || batch.slot - record.born > 1_500) continue;
      const advance = record.price / record.start;
      const net = record.bought - record.sold;
      if (record.buyers.size < 15 || net < MIN_FLOW || advance < 3.50 || advance > 5.00) continue;
      const cap = state.maxBuyLamports(mint);
      const size = cap < POSITION_SIZE ? cap : POSITION_SIZE;
      if (size < LAMPORTS_PER_SOL / 100n || available < size + feeReserve) continue;
      orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: 2_500 });
      tried.add(mint);
      entryCount++;
      buysSent++;
      available -= size + feeReserve;
    }
    return orders;
  },
});
