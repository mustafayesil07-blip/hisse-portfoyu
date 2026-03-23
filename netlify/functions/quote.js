/**
 * Netlify Serverless Function: quote
 * GET /.netlify/functions/quote?symbol=AAPL
 * GET /.netlify/functions/quote?symbol=AAPL,MSFT,TSLA
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
      timeout: 8000,
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

function r2(v) { return (v != null && v !== 0) ? Math.round(v * 100) / 100 : null; }

function buildQuote(symbol, price, prevClose, currency, time, extra) {
  price     = r2(price);
  prevClose = r2(prevClose);
  const change    = (price && prevClose) ? r2(price - prevClose) : null;
  const changePct = (price && prevClose && prevClose !== 0)
    ? Math.round((price - prevClose) / prevClose * 10000) / 100 : null;

  const q = {
    symbol: symbol.toUpperCase(),
    price,
    previousClose: prevClose,
    change,
    changePct,
    currency: currency || 'USD',
    updatedAt: new Date(time ? time * 1000 : Date.now()).toISOString(),
  };

  if (extra) {
    if (extra.preMarketPrice) {
      q.preMarketPrice     = r2(extra.preMarketPrice);
      q.preMarketChangePct = price
        ? Math.round((extra.preMarketPrice - price) / price * 10000) / 100 : null;
    }
    if (extra.postMarketPrice) {
      q.postMarketPrice     = r2(extra.postMarketPrice);
      q.postMarketChangePct = price
        ? Math.round((extra.postMarketPrice - price) / price * 10000) / 100 : null;
    }
    if (extra.marketState) q.marketState = extra.marketState;
  }

  return q;
}

async function fetchV7Single(symbol) {
  const fields = [
    'symbol','regularMarketPrice','previousClose',
    'regularMarketChange','regularMarketChangePercent',
    'currency','regularMarketTime',
    'preMarketPrice','preMarketChangePercent',
    'postMarketPrice','postMarketChangePercent','marketState',
  ].join(',');
  const url = 'https://query2.finance.yahoo.com/v7/finance/quote?symbols=' +
    encodeURIComponent(symbol) + '&fields=' + fields;
  const data = await get(url);
  const q = data?.quoteResponse?.result?.[0];
  if (!q || !q.regularMarketPrice) throw new Error('No v7 result for ' + symbol);
  return buildQuote(q.symbol, q.regularMarketPrice || q.previousClose, q.previousClose,
    q.currency, q.regularMarketTime, {
      preMarketPrice:  q.preMarketPrice  || null,
      postMarketPrice: q.postMarketPrice || null,
      marketState:     q.marketState     || null,
    });
}

async function fetchV7Bulk(symbols) {
  const fields = [
    'symbol','regularMarketPrice','previousClose',
    'regularMarketChange','regularMarketChangePercent',
    'currency','regularMarketTime',
    'preMarketPrice','preMarketChangePercent',
    'postMarketPrice','postMarketChangePercent','marketState',
  ].join(',');
  const url = 'https://query2.finance.yahoo.com/v7/finance/quote?symbols=' +
    symbols.map(encodeURIComponent).join(',') + '&fields=' + fields;
  const data = await get(url);
  const results = data?.quoteResponse?.result;
  if (!results || results.length === 0) throw new Error('No v7 results');
  return results.map(function(q) {
    return buildQuote(q.symbol, q.regularMarketPrice || q.previousClose, q.previousClose,
      q.currency, q.regularMarketTime, {
        preMarketPrice:  q.preMarketPrice  || null,
        postMarketPrice: q.postMarketPrice || null,
        marketState:     q.marketState     || null,
      });
  });
}

async function fetchV8(symbol) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(symbol) + '?range=2d&interval=1d&includePrePost=true';
  const data = await get(url);
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error('No result for ' + symbol);
  const price = meta.regularMarketPrice || meta.previousClose;
  if (!price || price <= 0) throw new Error('Zero price for ' + symbol);
  return buildQuote(meta.symbol || symbol, price,
    meta.previousClose || meta.chartPreviousClose,
    meta.currency, meta.regularMarketTime,
    { preMarketPrice: null, postMarketPrice: null, marketState: meta.marketState || null });
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-cache',
};

function ok(body)       { return { statusCode: 200, headers: CORS, body: JSON.stringify(body) }; }
function err(code, msg) { return { statusCode: code, headers: CORS, body: JSON.stringify({ error: msg }) }; }

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return err(405, 'Method not allowed');

  const rawSymbol = (event.queryStringParameters?.symbol || '').trim().toUpperCase();
  if (!rawSymbol) return err(400, 'Missing ?symbol= parameter');

  const symbols = rawSymbol.split(',').map(s => s.trim()).filter(Boolean);
  if (symbols.length > 20) return err(400, 'Max 20 symbols');
  for (const s of symbols) {
    if (!/^[A-Z0-9.\-^]{1,12}$/.test(s)) return err(400, 'Invalid symbol: ' + s);
  }

  try {
    if (symbols.length === 1) {
      // Tek sembol: v7 ile dene (preMarketPrice direkt geliyor)
      try { return ok(await fetchV7Single(symbols[0])); }
      catch(e) {
        console.warn('v7 single failed:', e.message);
        try { return ok(await fetchV8(symbols[0])); }
        catch(e2) { return err(404, 'Price not found for ' + symbols[0]); }
      }
    }

    // Çoklu: v7 bulk (pre/post direkt geliyor)
    try {
      const quotes = await fetchV7Bulk(symbols);
      const missing = symbols.filter(s => !quotes.find(q => q.symbol === s && q.price));
      for (const s of missing) {
        try { quotes.push(await fetchV7Single(s)); }
        catch(e) {
          try { quotes.push(await fetchV8(s)); }
          catch(e2) { quotes.push({ symbol: s, price: null, error: e2.message }); }
        }
      }
      return ok({ quotes });
    } catch(bulkErr) {
      console.warn('v7 bulk failed:', bulkErr.message);
      const results = await Promise.all(symbols.map(async s => {
        try { return await fetchV7Single(s); }
        catch(e) {
          try { return await fetchV8(s); }
          catch(e2) { return { symbol: s, price: null, error: e2.message }; }
        }
      }));
      return ok({ quotes: results });
    }
  } catch(e) {
    console.error('quote handler error:', e);
    return err(502, 'Provider error: ' + e.message);
  }
};
