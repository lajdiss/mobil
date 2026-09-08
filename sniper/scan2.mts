const get = async (q: string) =>
  (await (await globalThis.fetch(`https://frontend-api-v3.pump.fun/coins?${q}`)).json()) as any[];
const now = Date.now();
const show = (label: string, rows: any[]) => {
  console.log(`\n${label}`);
  console.log('sym          posl.koment   komentů  posl.obchod   mcap  complete');
  for (const c of rows.slice(0, 10)) {
    const rAgo = c.last_reply ? (now - c.last_reply) / 1000 : null;
    const tAgo = c.last_trade_timestamp ? (now - c.last_trade_timestamp) / 1000 : null;
    console.log(
      (c.symbol ?? '?').slice(0, 12).padEnd(13) +
        (rAgo === null ? '—' : rAgo < 3600 ? rAgo.toFixed(0) + 's' : (rAgo / 3600).toFixed(0) + 'h').padStart(12) +
        String(c.reply_count ?? 0).padStart(10) +
        (tAgo === null ? '—' : tAgo < 3600 ? tAgo.toFixed(0) + 's' : (tAgo / 3600).toFixed(0) + 'h').padStart(13) +
        (c.market_cap ?? 0).toFixed(0).padStart(8) +
        (c.complete ? '   yes' : '    no'),
    );
  }
};
show('sort=last_reply DESC', await get('limit=10&sort=last_reply&order=DESC&includeNsfw=false'));
show('sort=reply_count DESC', await get('limit=10&sort=reply_count&order=DESC&includeNsfw=false'));
show('sort=last_trade_timestamp DESC', await get('limit=10&sort=last_trade_timestamp&order=DESC&includeNsfw=false'));
