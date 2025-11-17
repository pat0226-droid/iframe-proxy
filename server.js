'use strict';

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// Helper: rewrite HTML asset paths to go through /proxy
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
    .replace(/(<link[^>]*\bhref=["'])([^"']+)(["'][^>]*>)/gi, (_, pre, url, post) => `${pre}${toProxy(url)}${post}`);
}

// Proxy endpoint
app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing ?url= parameter' });
  }

  try {
    const response = await axios.get(targetUrl, {
      responseType: 'arraybuffer',
      validateStatus: () => true,
    });

    // Copy headers with adjustments
    Object.entries(response.headers).forEach(([key, value]) => {
      if (!value) return;

      if (key.toLowerCase() === 'x-frame-options') return;

      if (key.toLowerCase() === 'content-security-policy') {
        let csp = value;
        if (/frame-ancestors[^;]*;/i.test(csp)) {
          csp = csp.replace(/frame-ancestors[^;]*;/i, 'frame-ancestors *;');
        } else {
          csp += '; frame-ancestors *;';
        }
        res.setHeader(key, csp);
        return;
      }

      if (key.toLowerCase() === 'set-cookie') {
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

    // Rewrite HTML if needed
    const contentType = response.headers['content-type'] || '';
    let body = response.data;

    if (/text\/html/i.test(contentType)) {
      const text = response.data.toString('utf8');
      const rewritten = rewriteHtmlBody(text, targetUrl);
      body = Buffer.from(rewritten, 'utf8');
      res.setHeader('content-length', Buffer.byteLength(body));
    }

    res.status(response.status).send(body);

  } catch (err) {
    console.error('[proxy error]', err.message);
    res.status(502).json({ error: 'Upstream unreachable or failed.' });
  }
});

// Index page
app.get('/', (req, res) => {
  res.type('html').send(`
    <h1>HTTP Proxy with iframe + DHTML rewriting</h1>
    <p>Use: <code>/proxy?url=https://example.com</code></p>
    <iframe src="/proxy?url=https://example.com" style="width:100%;height:400px;border:1px solid #ccc;"></iframe>
  `);
});

app.listen(PORT, () => {
  console.log(`HTTP proxy listening on http://localhost:${PORT}`);
});
