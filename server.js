'use strict';

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const zlib = require('zlib');

const app = express();
const PORT = 3000; // Always use port 3000

app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Helper: rewrite HTML asset paths, CSS urls, and form actions to go through /proxy
function rewriteHtmlBody(body, upstreamUrl) {
  if (!/<!DOCTYPE|<html|<head|<body/i.test(body)) return body;

  const urlObj = new URL(upstreamUrl);

  const toProxy = (u) => {
    try {
      const resolved = new URL(u, urlObj.origin);
      return `/proxy?url=${encodeURIComponent(resolved.toString())}`;
    } catch {
      return u;
    }
  };

  return body
    .replace(/(<iframe[^>]*\bsrc=["'])([^"']+)(["'][^>]*>)/gi, (_, pre, url, post) => `${pre}${toProxy(url)}${post}`)
    .replace(/(<a[^>]*\bhref=["'])([^"']+)(["'][^>]*>)/gi, (_, pre, url, post) => `${pre}${toProxy(url)}${post}`)
    .replace(/(<img[^>]*\bsrc=["'])([^"']+)(["'][^>]*>)/gi, (_, pre, url, post) => `${pre}${toProxy(url)}${post}`)
    .replace(/(<script[^>]*\bsrc=["'])([^"']+)(["'][^>]*>)/gi, (_, pre, url, post) => `${pre}${toProxy(url)}${post}`)
    .replace(/(<link[^>]*\bhref=["'])([^"']+)(["'][^>]*>)/gi, (_, pre, url, post) => `${pre}${toProxy(url)}${post}`)
    .replace(/(<form[^>]*\baction=["'])([^"']+)(["'][^>]*>)/gi, (_, pre, url, post) => `${pre}${toProxy(url)}${post}`)
    .replace(/url\(["']?([^"')]+)["']?\)/gi, (_, url) => `url(${toProxy(url)})`)
    .replace(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');
}

// Shared proxy logic
async function handleProxy(req, res, method) {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing ?url= parameter' });
  }

  try {
    const options = {
      method,
      url: targetUrl,
      responseType: 'arraybuffer',
      validateStatus: () => true,
      headers: {
        'User-Agent': 'NickProxy/1.0 (+http://localhost:3000)',
      },
    };
    if (method === 'POST') {
      options.data = req.body;
    }

    const response = await axios(options);

    // Copy headers with adjustments
    Object.entries(response.headers).forEach(([key, value]) => {
      if (!value) return;
      const lower = key.toLowerCase();

      if (lower === 'x-frame-options') return;

      if (lower === 'content-security-policy') {
        let csp = value;
        if (/frame-ancestors[^;]*;/i.test(csp)) {
          csp = csp.replace(/frame-ancestors[^;]*;/i, 'frame-ancestors *;');
        } else {
          csp += '; frame-ancestors *;';
        }
        res.setHeader(key, csp);
        return;
      }

      if (lower === 'set-cookie') {
        const cookies = Array.isArray(value) ? value : [value];
        const rewritten = cookies.map((c) => {
          let cookie = c.replace(/;\s*SameSite=[^;]*/i, '');
          if (!/;\s*SameSite=None/i.test(cookie)) {
            cookie += '; SameSite=None';
          }
          cookie = cookie.replace(/;\s*Secure/i, '');
          return cookie;
        });
        res.setHeader(key, rewritten);
        return;
      }

      res.setHeader(key, value);
    });

    // Decompress if needed
    let data = response.data;
    const encoding = response.headers['content-encoding'];
    if (encoding === 'gzip') {
      data = zlib.gunzipSync(data);
    } else if (encoding === 'deflate') {
      data = zlib.inflateSync(data);
    }

    // Rewrite HTML if needed
    const contentType = response.headers['content-type'] || '';
    let body = data;

    if (/text\/html/i.test(contentType)) {
      const text = data.toString('utf8');
      const rewritten = rewriteHtmlBody(text, targetUrl);
      body = Buffer.from(rewritten, 'utf8');
      res.setHeader('content-length', Buffer.byteLength(body));
    }

    res.status(response.status).send(body);

  } catch (err) {
    console.error('[proxy error]', err.message);
    res.status(502).json({ error: 'Upstream unreachable or failed.' });
  }
}

// Routes
app.get('/proxy', (req, res) => handleProxy(req, res, 'GET'));
app.post('/proxy', (req, res) => handleProxy(req, res, 'POST'));

app.get('/', (req, res) => {
  res.type('html').send(`
    <h1>HTTP Proxy with iframe + DHTML rewriting</h1>
    <p>Use: <code>/proxy?url=https://example.com</code></p>
    <iframe src="/proxy?url=https://wikipedia.org" style="width:100%;height:400px;border:1px solid #ccc;"></iframe>
  `);
});

app.listen(PORT, () => {
  console.log(`HTTP proxy listening on http://localhost:${PORT}`);
});

