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
  const targetUrl = req.query.url
