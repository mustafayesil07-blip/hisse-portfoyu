/**
 * Netlify Serverless Function: /api/quote
 *
 * GET /api/quote?symbol=AAPL
 * GET /api/quote?symbol=AAPL,MSFT,TSLA   (bulk, comma-separated)
 *
 * Returns:
 *   Single:  { symbol, price, currency, updatedAt }
 *   Bulk:    { quotes: [ { symbol, price, currency, updatedAt }, ... ] }
 *
 * Provider: Yahoo Finance v8 chart API (no API key needed — server-side only)
 * Fallback: Yahoo Finance v7 quote API
 */

const https = require('https');

// ── HTTP GET helper (Node built-in, no dependencies) ──────────────
function get(url) {
  return new Promise(function (resolve, reject) {
    const req = https.get(
      url,
      {
        headers: {
          // Yahoo requires a real-looking User-Agent; without it returns 429/403
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          Origin: 'https://finance.yahoo.com',
          Referer: 'https://finance.yahoo.com/',
        },
        timeout: 8000,
      },
      function (res) {
        const chunks = [];
        res.on('data', function (c) { chunks.push(c); });
        res.on('end', function () {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) {
            return reject(new Error('HTTP ' + res.statusCode + ': ' + body.slice(0, 200)));
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error('JSON parse error: ' + body.slice(0, 200)));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', function () { req.destroy(); reject(new Error('Request timeout')); });
  });
}

// ── Yahoo Finance v8 chart (single ticker) ────────────────────────
async function fetchV8(symbol) {
  const url =
    'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(symbol) +
    '?range=1d&interval=1d&includePrePost=false';
  const data = await get(url);
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error('No chart result for ' + symbol);
  const price = meta.regularMarketPrice || meta.previousClose;
  if (!price || price <= 0) throw new Error('Zero price for ' + symbol);
  return {
    symbol: meta.symbol || symbol.toUpperCase(),
    price: Math.round(price * 100) / 100,
    currency: meta.currency || 'USD',
    updatedAt: new Date(meta.regularMarketTime
      ? meta.regularMarketTime * 1000
      : Date.now()
    ).toISOString(),
  };
}

// ── Yahoo Finance v7 quote (bulk, up to ~50 tickers) ─────────────
async function fetchV7Bulk(symbols) {
  const url =
    'https://query1.finance.yahoo.com/v7/finance/quote?symbols=' +
    symbols.map(encodeURIComponent).join(',') +
    '&fields=symbol,regularMarketPrice,currency,regularMarketTime,previousClose';
  const data = await get(url);
  const results = data?.quoteResponse?.result;
  if (!results || results.length === 0) throw new Error('No v7 results');
  return results.map(function (q) {
    const price = q.regularMarketPrice || q.previousClose;
    return {
      symbol: q.symbol,
      price: price ? Math.round(price * 100) / 100 : null,
      currency: q.currency || 'USD',
      updatedAt: new Date(
        q.regularMarketTime ? q.regularMarketTime * 1000 : Date.now()
      ).toISOString(),
    };
  });
}

// ── CORS headers ──────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=60', // cache 60s to avoid hammering Yahoo
};

function ok(body) {
  return { statusCode: 200, headers: CORS, body: JSON.stringify(body) };
}
function err(code, message) {
  return { statusCode: code, headers: CORS, body: JSON.stringify({ error: message }) };
}

// ── Handler ───────────────────────────────────────────────────────
exports.handler = async function (event) {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return err(405, 'Method not allowed');
  }

  const rawSymbol = (event.queryStringParameters?.symbol || '').trim().toUpperCase();
  if (!rawSymbol) {
    return err(400, 'Missing ?symbol= parameter. Example: /api/quote?symbol=AAPL');
  }

  // Validate: only letters, digits, dots, hyphens; max 10 tickers
  const symbols = rawSymbol.split(',').map(s => s.trim()).filter(Boolean);
  if (symbols.length > 20) return err(400, 'Max 20 symbols per request');
  for (const s of symbols) {
    if (!/^[A-Z0-9.\-^]{1,12}$/.test(s)) {
      return err(400, 'Invalid symbol: ' + s);
    }
  }

  try {
    // Single symbol → v8 (more reliable for single)
    if (symbols.length === 1) {
      try {
        const quote = await fetchV8(symbols[0]);
        return ok(quote);
      } catch (e) {
        // fallback to v7 for single too
        console.warn('v8 failed for', symbols[0], e.message, '— trying v7');
        const quotes = await fetchV7Bulk(symbols);
        const q = quotes[0];
        if (!q || !q.price) return err(404, 'Price not found for ' + symbols[0]);
        return ok(q);
      }
    }

    // Multiple symbols → v7 bulk first, fall back to parallel v8
    try {
      const quotes = await fetchV7Bulk(symbols);
      // Fill in any missing with v8
      const missing = symbols.filter(
        s => !quotes.find(q => q.symbol === s && q.price)
      );
      for (const s of missing) {
        try {
          const q = await fetchV8(s);
          quotes.push(q);
        } catch (e) {
          console.warn('v8 fallback failed for', s, e.message);
          quotes.push({ symbol: s, price: null, currency: 'USD', updatedAt: new Date().toISOString(), error: e.message });
        }
      }
      return ok({ quotes });
    } catch (bulkErr) {
      console.warn('v7 bulk failed:', bulkErr.message, '— falling back to parallel v8');
      // Parallel v8 for each
      const results = await Promise.all(
        symbols.map(async s => {
          try { return await fetchV8(s); }
          catch (e) { return { symbol: s, price: null, currency: 'USD', updatedAt: new Date().toISOString(), error: e.message }; }
        })
      );
      return ok({ quotes: results });
    }

  } catch (e) {
    console.error('quote handler error:', e);
    return err(502, 'Provider error: ' + e.message);
  }
};
