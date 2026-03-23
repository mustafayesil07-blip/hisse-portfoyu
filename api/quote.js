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

function r2(n) { return n != null ? Math.round(n * 100) / 100 : null; }
function pct(price, prev) {
  if (!price || !prev || prev === 0) return null;
  return Math.round((price - prev) / prev * 10000) / 100;
}

function buildQuote(q) {
  const price    = r2(q.regularMarketPrice || q.previousClose);
  const prev     = r2(q.regularMarketPreviousClose || q.previousClose);
  const prePrice = r2(q.preMarketPrice);
  const postPrice = r2(q.postMarketPrice);
  return {
    symbol:   q.symbol,
    price,
    previousClose: prev,
    change:    r2(q.regularMarketChange) || r2(price - prev),
    changePct: r2(q.regularMarketChangePercent) || pct(price, prev),
    preMarketPrice:      prePrice,
    preMarketChange:     prePrice  ? r2(prePrice  - price) : null,
    preMarketChangePct:  prePrice  ? pct(prePrice,  price) : null,
    postMarketPrice:     postPrice,
    postMarketChange:    postPrice ? r2(postPrice - price) : null,
    postMarketChangePct: postPrice ? pct(postPrice, price) : null,
    marketState: q.marketState || 'CLOSED',
    currency:   q.currency || 'USD',
    updatedAt:  new Date(q.regularMarketTime ? q.regularMarketTime * 1000 : Date.now()).toISOString(),
  };
}

async function fetchV7Bulk(symbols) {
  const fields = 'symbol,regularMarketPrice,regularMarketPreviousClose,regularMarketChange,regularMarketChangePercent,previousClose,preMarketPrice,postMarketPrice,marketState,currency,regularMarketTime';
  const url = 'https://query1.finance.yahoo.com/v7/finance/quote?symbols=' +
    symbols.map(encodeURIComponent).join(',') + '&fields=' + fields;
  const data = await get(url);
  const results = data?.quoteResponse?.result;
  if (!results || results.length === 0) throw new Error('No v7 results');
  return results.map(buildQuote);
}

async function fetchV8(symbol) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(symbol) + '?range=2d&interval=1d&includePrePost=true';
  const data = await get(url);
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error('No result for ' + symbol);
  const price = meta.regularMarketPrice || meta.previousClose;
  if (!price || price <= 0) throw new Error('Zero price for ' + symbol);
  const prev = meta.previousClose || meta.chartPreviousClose;
  return {
    symbol: meta.symbol || symbol.toUpperCase(),
    price: r2(price), previousClose: r2(prev),
    change: r2(price - prev), changePct: pct(price, prev),
    preMarketPrice: null, preMarketChange: null, preMarketChangePct: null,
    postMarketPrice: null, postMarketChange: null, postMarketChangePct: null,
    marketState: 'CLOSED',
    currency: meta.currency || 'USD',
    updatedAt: new Date(meta.regularMarketTime ? meta.regularMarketTime * 1000 : Date.now()).toISOString(),
  };
}

// ── Vercel handler format ─────────────────────────────────────────
module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=30');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const rawSymbol = ((req.query && req.query.symbol) || '').trim().toUpperCase();
  if (!rawSymbol) return res.status(400).json({ error: 'Missing ?symbol= parameter' });

  const symbols = rawSymbol.split(',').map(s => s.trim()).filter(Boolean);
  if (symbols.length > 20) return res.status(400).json({ error: 'Max 20 symbols' });
  for (const s of symbols) {
    if (!/^[A-Z0-9.\-^]{1,12}$/.test(s)) return res.status(400).json({ error: 'Invalid symbol: ' + s });
  }

  try {
    try {
      const quotes = await fetchV7Bulk(symbols);
      const got = new Set(quotes.map(q => q.symbol));
      const missing = symbols.filter(s => !got.has(s));
      for (const s of missing) {
        try { quotes.push(await fetchV8(s)); }
        catch(e) { quotes.push({ symbol: s, price: null, error: e.message }); }
      }
      if (symbols.length === 1) return res.status(200).json(quotes[0]);
      return res.status(200).json({ quotes });
    } catch(v7Err) {
      console.warn('v7 failed:', v7Err.message);
      const results = await Promise.all(symbols.map(async s => {
        try { return await fetchV8(s); }
        catch(e) { return { symbol: s, price: null, error: e.message }; }
      }));
      if (symbols.length === 1) return res.status(200).json(results[0]);
      return res.status(200).json({ quotes: results });
    }
  } catch(e) {
    console.error('handler error:', e);
    return res.status(502).json({ error: 'Provider error: ' + e.message });
  }
};


