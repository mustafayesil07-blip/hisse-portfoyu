const https = require('https');

function get(url) {
  return new Promise(function(resolve, reject) {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://finance.yahoo.com',
        'Referer': 'https://finance.yahoo.com/',
      },
      timeout: 10000,
    }, function(res) {
      const chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) return reject(new Error('HTTP ' + res.statusCode));
        try { resolve(JSON.parse(body)); } catch(e) { reject(new Error('JSON parse error')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('Timeout')); });
  });
}

function r2(n) { return (n != null && !isNaN(n)) ? Math.round(n * 100) / 100 : null; }
function pct(price, prev) {
  if (!price || !prev || prev === 0) return null;
  return Math.round((price - prev) / prev * 10000) / 100;
}

// v8 chart API — most reliable, includes pre/post via meta fields
async function fetchV8Single(symbol) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(symbol) +
    '?range=1d&interval=1m&includePrePost=true&includeTimestamps=false';
  const data = await get(url);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error('No result for ' + symbol);
  const meta = result.meta;
  if (!meta) throw new Error('No meta for ' + symbol);

  const price       = r2(meta.regularMarketPrice);
  const prev        = r2(meta.previousClose || meta.chartPreviousClose);
  const prePrice    = r2(meta.preMarketPrice);
  const postPrice   = r2(meta.postMarketPrice);
  const marketState = meta.marketState || 'CLOSED'; // PRE | REGULAR | POST | CLOSED | PREPRE | POSTPOST

  return {
    symbol:   (meta.symbol || symbol).toUpperCase(),
    price,
    previousClose: prev,
    change:    r2(meta.regularMarketChange)        || r2(price - prev),
    changePct: r2(meta.regularMarketChangePercent) || pct(price, prev),

    preMarketPrice:      prePrice,
    preMarketChange:     prePrice  != null ? r2(prePrice  - price) : null,
    preMarketChangePct:  prePrice  != null ? pct(prePrice,  price)  : null,

    postMarketPrice:     postPrice,
    postMarketChange:    postPrice != null ? r2(postPrice - price) : null,
    postMarketChangePct: postPrice != null ? pct(postPrice, price)  : null,

    marketState,
    currency:  meta.currency || 'USD',
    updatedAt: new Date(meta.regularMarketTime
      ? meta.regularMarketTime * 1000
      : Date.now()
    ).toISOString(),
  };
}

// v7 bulk — faster for many tickers, also has pre/post fields
async function fetchV7Bulk(symbols) {
  const fields = [
    'symbol','regularMarketPrice','regularMarketPreviousClose',
    'regularMarketChange','regularMarketChangePercent','previousClose',
    'preMarketPrice','preMarketChange','preMarketChangePercent',
    'postMarketPrice','postMarketChange','postMarketChangePercent',
    'marketState','currency','regularMarketTime'
  ].join(',');
  const url = 'https://query1.finance.yahoo.com/v7/finance/quote?symbols=' +
    symbols.map(encodeURIComponent).join(',') + '&fields=' + fields;
  const data = await get(url);
  const results = data?.quoteResponse?.result;
  if (!results || results.length === 0) throw new Error('No v7 results');

  return results.map(function(q) {
    const price    = r2(q.regularMarketPrice);
    const prev     = r2(q.regularMarketPreviousClose || q.previousClose);
    const prePrice = r2(q.preMarketPrice);
    const postPrice = r2(q.postMarketPrice);
    const ms = q.marketState || 'CLOSED';

    // If v7 returns null for pre/post, we'll flag it for v8 retry
    return {
      symbol:   q.symbol,
      price,
      previousClose: prev,
      change:    r2(q.regularMarketChange)        || r2(price - prev),
      changePct: r2(q.regularMarketChangePercent) || pct(price, prev),

      preMarketPrice:      prePrice,
      preMarketChange:     prePrice  != null ? r2(q.preMarketChange   || prePrice  - price) : null,
      preMarketChangePct:  prePrice  != null ? r2(q.preMarketChangePercent  || pct(prePrice,  price)) : null,

      postMarketPrice:     postPrice,
      postMarketChange:    postPrice != null ? r2(q.postMarketChange  || postPrice - price) : null,
      postMarketChangePct: postPrice != null ? r2(q.postMarketChangePercent || pct(postPrice, price)) : null,

      marketState: ms,
      currency:   q.currency || 'USD',
      updatedAt:  new Date(q.regularMarketTime ? q.regularMarketTime * 1000 : Date.now()).toISOString(),
      _needsExtended: (ms === 'PRE' || ms === 'POST' || ms === 'PREPRE' || ms === 'POSTPOST') && prePrice == null && postPrice == null,
    };
  });
}

// ── Vercel handler ────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=30');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const rawSymbol = ((req.query && req.query.symbol) || '').trim().toUpperCase();
  if (!rawSymbol) return res.status(400).json({ error: 'Missing ?symbol=' });

  const symbols = rawSymbol.split(',').map(s => s.trim()).filter(Boolean);
  if (symbols.length > 20) return res.status(400).json({ error: 'Max 20 symbols' });
  for (const s of symbols) {
    if (!/^[A-Z0-9.\-^]{1,12}$/.test(s)) return res.status(400).json({ error: 'Invalid symbol: ' + s });
  }

  try {
    // Single symbol → v8 directly (most accurate, includes pre/post)
    if (symbols.length === 1) {
      try {
        const q = await fetchV8Single(symbols[0]);
        return res.status(200).json(q);
      } catch(e) {
        console.warn('v8 single failed for', symbols[0], e.message);
        return res.status(502).json({ error: 'Price fetch failed: ' + e.message });
      }
    }

    // Multiple symbols → v7 bulk, then v8 retry for any missing extended hours data
    try {
      const quotes = await fetchV7Bulk(symbols);

      // For tickers where v7 returned null pre/post despite being in extended hours,
      // retry individually with v8 (runs in parallel)
      const retries = quotes
        .filter(q => q._needsExtended)
        .map(async function(q) {
          try {
            const fresh = await fetchV8Single(q.symbol);
            // Merge v8 extended data into v7 quote
            q.preMarketPrice      = fresh.preMarketPrice;
            q.preMarketChange     = fresh.preMarketChange;
            q.preMarketChangePct  = fresh.preMarketChangePct;
            q.postMarketPrice     = fresh.postMarketPrice;
            q.postMarketChange    = fresh.postMarketChange;
            q.postMarketChangePct = fresh.postMarketChangePct;
            q.marketState         = fresh.marketState;
          } catch(e) {
            console.warn('v8 retry failed for', q.symbol, e.message);
          }
          delete q._needsExtended;
        });

      await Promise.all(retries);
      quotes.forEach(q => delete q._needsExtended);

      // Fill any symbols missing from v7 entirely
      const got = new Set(quotes.map(q => q.symbol));
      const missing = symbols.filter(s => !got.has(s));
      for (const s of missing) {
        try { quotes.push(await fetchV8Single(s)); }
        catch(e) { quotes.push({ symbol: s, price: null, error: e.message }); }
      }

      return res.status(200).json({ quotes });

    } catch(v7Err) {
      console.warn('v7 bulk failed:', v7Err.message, '— parallel v8 fallback');
      const results = await Promise.all(symbols.map(async s => {
        try { return await fetchV8Single(s); }
        catch(e) { return { symbol: s, price: null, error: e.message }; }
      }));
      return res.status(200).json({ quotes: results });
    }

  } catch(e) {
    console.error('handler error:', e);
    return res.status(502).json({ error: 'Provider error: ' + e.message });
  }
};


