'use strict';

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const zlib = require('zlib');

const app = express();
const PORT = process.env.PORT || 3000;

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
