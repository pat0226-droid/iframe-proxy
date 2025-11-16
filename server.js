
const fs = require('fs');
const http = require('http');
const https = require('https');
const express = require('express');

const app = express();

// your app routes go here...

let server;

try {
  const privateKey = fs.readFileSync('./localhost+2-key.pem', 'utf8');
  const certificate = fs.readFileSync('./localhost+2.pem', 'utf8');

  const credentials = { key: privateKey, cert: certificate };
  server = https.createServer(credentials, app);
  console.log('✅ HTTPS server running on https://localhost:3000');
} catch (err) {
  console.warn('⚠️ Certificates not found, falling back to HTTP:', err.message);
  server = http.createServer(app);
  console.log('✅ HTTP server running on http://localhost:3000');
}

server.listen(3000);
