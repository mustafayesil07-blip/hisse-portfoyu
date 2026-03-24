/**
 * Vercel Serverless Function: /api/quote
 * Pre/post market dahil tam fiyat verisi
 * Yahoo Finance cookie+crumb authentication ile
 */

const https = require('https');

// ── Cookie/Crumb cache (Vercel fonksiyonu warm olduğu sürece yaşar) ──
let _cookie = null;
let _crumb  = null;
let _cookieTime = 0;
const CACHE_TTL = 8 * 60 * 1000; // 8 dakika

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: Object.assign({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      }, headers || {}),
      timeout: 10000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function getCookieAndCrumb() {
  const now = Date.now();
  if (_cookie && _crumb && (now - _cookieTime) < CACHE_TTL) {
    return { cookie: _cookie, crumb: _crumb };
  }

  // Step 1: Get consent cookie from Yahoo
  const r1 = await httpsGet('https://fc.yahoo.com', {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  });
  
  // Extract set-cookie header
  const setCookie = r1.headers['set-cookie'];
  let cookie = '';
  if (setCookie) {
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    cookie = cookies
      .map(c => c.split(';')[0])
      .filter(c => c.includes('='))
      .join('; ');
  }

  // If fc.yahoo.com didn't give us a cookie, try the consent page
  if (!cookie) {
    const r2 = await httpsGet('https://consent.yahoo.com/v2/collectConsent?sessionId=1', {
      'Accept': 'text/html',
    });
    const sc2 = r2.headers['set-cookie'];
    if (sc2) {
      const cookies = Array.isArray(sc2) ? sc2 : [sc2];
      cookie = cookies.map(c => c.split(';')[0]).filter(c => c.includes('=')).join('; ');
    }
  }

  // Step 2: Get crumb
  const r3 = await httpsGet('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    'Cookie': cookie,
    'Accept': 'text/plain',
    'Origin': 'https://finance.yahoo.com',
    'Referer': 'https://finance.yahoo.com/',
  });

  const crumb = r3.body.trim().replace(/"/g, '');
  
  if (crumb && crumb.length > 3 && !crumb.includes('<')) {
    _cookie = cookie;
    _crumb  = crumb;
    _cookieTime = now;
    console.log('Yahoo crumb obtained:', crumb.slice(0,8) + '...');
  } else {
    console.warn('Could not get crumb, body:', r3.body.slice(0,100));
    // Continue without crumb - some data will still work
    _cookie = cookie;
    _crumb  = '';
    _cookieTime = now;
  }

  return { cookie: _cookie, crumb: _crumb };
}

function r2(n) {
  return (n != null && n !== undefined && !isNaN(Number(n))) ? Math.round(Number(n) * 100) / 100 : null;
}
function calcPct(price, prev) {
  if (!price || !prev || prev === 0) return null;
  return Math.round((price - prev) / prev * 10000) / 100;
}

async function fetchQuotes(symbols) {
  const { cookie, crumb } = await getCookieAndCrumb();

  // Build URL - use v10 quoteSummary for richest data
  // Actually v7/finance/quote with crumb is most reliable for bulk
  const fields = [
    'symbol', 'shortName',
    'regularMarketPrice', 'regularMarketPreviousClose',
    'regularMarketChange', 'regularMarketChangePercent',
    'regularMarketTime',
    'preMarketPrice', 'preMarketChange', 'preMarketChangePercent', 'preMarketTime',
    'postMarketPrice', 'postMarketChange', 'postMarketChangePercent', 'postMarketTime',
    'marketState', 'currency', 'exchangeTimezoneName',
  ].join(',');

  const crumbParam = crumb ? `&crumb=${encodeURIComponent(crumb)}` : '';
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols.map(encodeURIComponent).join(',')}&fields=${fields}${crumbParam}`;

  const res = await httpsGet(url, {
    'Cookie': cookie,
    'Accept': 'application/json',
    'Origin': 'https://finance.yahoo.com',
    'Referer': 'https://finance.yahoo.com/',
  });

  if (res.status === 401) {
    // Cookie expired, reset and retry once
    _cookie = null; _crumb = null; _cookieTime = 0;
    return fetchQuotes(symbols);
  }
  if (res.status >= 400) throw new Error('Yahoo HTTP ' + res.status);

  let data;
  try { data = JSON.parse(res.body); } catch(e) { throw new Error('JSON parse: ' + res.body.slice(0,100)); }

  const results = data?.quoteResponse?.result;
  if (!results || results.length === 0) throw new Error('No results from Yahoo');

  return results.map(q => {
    const price    = r2(q.regularMarketPrice);
    const prev     = r2(q.regularMarketPreviousClose);
    const prePrice = r2(q.preMarketPrice);
    const postPrice = r2(q.postMarketPrice);
    const ms = q.marketState || 'CLOSED';

    return {
      symbol:   q.symbol,
      price,
      previousClose: prev,
      change:    r2(q.regularMarketChange)        ?? r2(price != null && prev != null ? price - prev : null),
      changePct: r2(q.regularMarketChangePercent) ?? calcPct(price, prev),

      preMarketPrice:      prePrice,
      preMarketChange:     r2(q.preMarketChange)        ?? (prePrice != null && price != null ? r2(prePrice - price) : null),
      preMarketChangePct:  r2(q.preMarketChangePercent) ?? calcPct(prePrice, price),
      preMarketTime:       q.preMarketTime || null,

      postMarketPrice:     postPrice,
      postMarketChange:    r2(q.postMarketChange)        ?? (postPrice != null && price != null ? r2(postPrice - price) : null),
      postMarketChangePct: r2(q.postMarketChangePercent) ?? calcPct(postPrice, price),
      postMarketTime:      q.postMarketTime || null,

      marketState: ms,
      currency:   q.currency || 'USD',
      updatedAt:  new Date(q.regularMarketTime ? q.regularMarketTime * 1000 : Date.now()).toISOString(),
    };
  });
}

// ── Vercel handler ─────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=20');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const rawSymbol = ((req.query && req.query.symbol) || '').trim().toUpperCase();
  if (!rawSymbol) return res.status(400).json({ error: 'Missing ?symbol=' });

  const symbols = rawSymbol.split(',').map(s => s.trim()).filter(Boolean);
  if (symbols.length > 20) return res.status(400).json({ error: 'Max 20 symbols' });
  for (const s of symbols) {
    if (!/^[A-Z0-9.\-^]{1,12}$/.test(s)) return res.status(400).json({ error: 'Invalid symbol: ' + s });
  }

  try {
    const quotes = await fetchQuotes(symbols);
    if (symbols.length === 1) return res.status(200).json(quotes[0] || { error: 'Not found' });
    return res.status(200).json({ quotes });
  } catch(e) {
    console.error('quote error:', e.message);
    return res.status(502).json({ error: e.message });
  }
};
