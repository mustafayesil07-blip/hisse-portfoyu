/**
 * Netlify Serverless Function: /api/quote
 * GET /api/quote?symbol=AAPL
 * GET /api/quote?symbol=AAPL,MSFT,TSLA
 *
 * Returns per symbol:
 * {
 *   symbol, price, previousClose, change, changePct,
 *   preMarketPrice, preMarketChange, preMarketChangePct,
 *   postMarketPrice, postMarketChange, postMarketChangePct,
 *   marketState,   // "PRE" | "REGULAR" | "POST" | "CLOSED"
 *   currency, updatedAt
 * }
 */

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
  if (price == null || prev == null || prev === 0) return null;
  return Math.round((price - prev) / prev * 10000) / 100;
}

function buildQuote(q) {
  // q is a Yahoo Finance v7 quoteResponse result object
  const price    = r2(q.regularMarketPrice || q.previousClose);
  const prev     = r2(q.regularMarketPreviousClose || q.previousClose);
  const change   = r2(q.regularMarketChange);
  const changePct = r2(q.regularMarketChangePercent);

  const prePrice  = r2(q.preMarketPrice);
  const postPrice = r2(q.postMarketPrice);

  return {
    symbol:   q.symbol,
    price,
    previousClose: prev,
    change:    change   != null ? change   : r2(price - prev),
    changePct: changePct != null ? changePct : pct(price, prev),

    // Pre-market
    preMarketPrice:     prePrice,
    preMarketChange:    prePrice != null ? r2(prePrice - price) : null,
    preMarketChangePct: prePrice != null ? pct(prePrice, price) : null,

    // Post-market
    postMarketPrice:     postPrice,
    postMarketChange:    postPrice != null ? r2(postPrice - price) : null,
    postMarketChangePct: postPrice != null ? pct(postPrice, price) : null,

    marketState: q.marketState || 'CLOSED',  // PRE | REGULAR | POST | CLOSED
    currency:   q.currency || 'USD',
    updatedAt:  new Date(q.regularMarketTime ? q.regularMarketTime * 1000 : Date.now()).toISOString(),
  };
}

// v7 supports pre/post market fields — use it for all requests
async function fetchV7Bulk(symbols) {
  const fields = [
    'symbol','regularMarketPrice','regularMarketPreviousClose','regularMarketChange',
    'regularMarketChangePercent','previousClose','preMarketPrice','postMarketPrice',
    'marketState','currency','regularMarketTime'
  ].join(',');
  const url = 'https://query1.finance.yahoo.com/v7/finance/quote?symbols=' +
    symbols.map(encodeURIComponent).join(',') + '&fields=' + fields;
  const data = await get(url);
  const results = data?.quoteResponse?.result;
  if (!results || results.length === 0) throw new Error('No v7 results');
  return results.map(buildQuote);
}

// v8 fallback (no pre/post market, but more reliable for single tickers)
async function fetchV8(symbol) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(symbol) + '?range=2d&interval=1d&includePrePost=true';
  const data = await get(url);
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error('No chart result for ' + symbol);
  const price = meta.regularMarketPrice || meta.previousClose;
  if (!price || price <= 0) throw new Error('Zero price for ' + symbol);
  return {
    symbol:   meta.symbol || symbol.toUpperCase(),
    price:    r2(price),
    previousClose: r2(meta.previousClose || meta.chartPreviousClose),
    change:    r2(price - (meta.previousClose || price)),
    changePct: pct(price, meta.previousClose),
    preMarketPrice:     null,
    preMarketChange:    null,
    preMarketChangePct: null,
    postMarketPrice:     null,
    postMarketChange:    null,
    postMarketChangePct: null,
    marketState: 'CLOSED',
    currency:   meta.currency || 'USD',
    updatedAt:  new Date(meta.regularMarketTime ? meta.regularMarketTime * 1000 : Date.now()).toISOString(),
  };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=30',  // 30s cache for extended hours freshness
};

function ok(body)       { return { statusCode: 200, headers: CORS, body: JSON.stringify(body) }; }
function fail(code, msg){ return { statusCode: code, headers: CORS, body: JSON.stringify({ error: msg }) }; }

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return fail(405, 'Method not allowed');

  const rawSymbol = (event.queryStringParameters?.symbol || '').trim().toUpperCase();
  if (!rawSymbol) return fail(400, 'Missing ?symbol=');

  const symbols = rawSymbol.split(',').map(s => s.trim()).filter(Boolean);
  if (symbols.length > 20) return fail(400, 'Max 20 symbols');
  for (const s of symbols) {
    if (!/^[A-Z0-9.\-^]{1,12}$/.test(s)) return fail(400, 'Invalid symbol: ' + s);
  }

  try {
    // Always try v7 bulk first (has pre/post market data)
    try {
      const quotes = await fetchV7Bulk(symbols);

      // Fill in any missing symbols with v8
      const got = new Set(quotes.map(q => q.symbol));
      const missing = symbols.filter(s => !got.has(s));
      for (const s of missing) {
        try { quotes.push(await fetchV8(s)); }
        catch(e) { quotes.push({ symbol: s, price: null, error: e.message }); }
      }

      if (symbols.length === 1) return ok(quotes[0]);
      return ok({ quotes });

    } catch(v7Err) {
      console.warn('v7 bulk failed:', v7Err.message, '— falling back to parallel v8');
      const results = await Promise.all(symbols.map(async s => {
        try { return await fetchV8(s); }
        catch(e) { return { symbol: s, price: null, error: e.message }; }
      }));
      if (symbols.length === 1) return ok(results[0]);
      return ok({ quotes: results });
    }

  } catch(e) {
    console.error('handler error:', e);
    return fail(502, 'Provider error: ' + e.message);
  }
};
