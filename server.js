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
      headers: {
        // Set a clear User-Agent to respect robots policy
        'User-Agent': 'NickProxy/1.0 (+http://localhost:3000)',
      },
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
    let body = response.data
