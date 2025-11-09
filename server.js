const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = 3000;

app.use(cors());

app.get('/', (req, res) => {
  res.send(`<html>
    <body>
      <h2>iframe-proxy</h2>
      <p>Usage: <code>/proxy?url=https%3A%2F%2Fexample.com</code></p>
      <p>Example: <a href="/proxy?url=https%3A%2F%2Fexample.com">/proxy?url=https%3A%2F%2Fexample.com</a></p>
    </body>
  </html>`);
});

app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing url parameter');

  try {
    const urlObj = new URL(targetUrl);
    if (!['http:', 'https:'].includes(urlObj.protocol)) {
      return res.status(400).send('Invalid URL protocol');
    }

    const upstream = await axios.get(targetUrl, {
      responseType: 'stream',
      headers: { 'User-Agent': 'Mozilla/5.0' },
      validateStatus: null
    });

    const drop = new Set([
      'connection','keep-alive','proxy-authenticate','proxy-authorization',
      'te','trailer','transfer-encoding','upgrade',
      'x-frame-options','content-security-policy','frame-options'
    ]);

    Object.entries(upstream.headers).forEach(([k, v]) => {
      if (!drop.has(k.toLowerCase())) res.set(k, v);
    });

    res.status(upstream.status);
    upstream.data.pipe(res);
  } catch (err) {
    if (err.response) res.status(err.response.status || 502).send(err.response.statusText || 'Upstream error');
    else res.status(500).send(err.message);
  }
});

app.listen(PORT, () => {
  console.log(`Proxy server running at http://localhost:${PORT}`);
});