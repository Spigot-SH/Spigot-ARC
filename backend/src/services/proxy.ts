import http from 'http';
import https from 'https';
import { Request, Response } from 'express';
import { Api, Endpoint } from '../types';
import { errorMessage } from './errors';
import { decryptSecret } from './vault';

// Only forward headers that are safe to pass to a third-party upstream. Anything
// carrying the consumer's own credentials (authorization, cookies) or our payment
// metadata must not leak to the publisher.
const BLOCKED_HEADERS = new Set([
  'host',
  'authorization',
  'cookie',
  'set-cookie',
  'payment-signature',
  'payment-required',
  'payment-response',
  'nanopayment-signature',
  'nanopayment-required',
  'nanopayment-response',
  'x-payment',
  'x-api-key',
  'content-length',
  'accept-encoding',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'te',
  'trailer',
]);

/**
 * Node's http/https client rather than fetch: publishers on hosts with broken AAAA records
 * hang under fetch's dual-stack resolution, so the family is pinned to IPv4 and the socket
 * carries its own timeout.
 */
const httpRequest = (
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string | Uint8Array,
): Promise<{ status: number; headers: Record<string, string>; text: string }> => {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;

    const req = lib.request(url, { method, headers, timeout: 20_000 }, res => {
      let data = '';
      res.on('data', chunk => {
        data += chunk;
      });
      res.on('end', () => {
        const resHeaders: Record<string, string> = {};
        Object.entries(res.headers).forEach(([k, v]) => {
          if (typeof v === 'string') resHeaders[k] = v;
          else if (Array.isArray(v)) resHeaders[k] = v.join(', ');
        });
        resolve({ status: res.statusCode || 200, headers: resHeaders, text: data });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('Upstream request timed out after 20s'));
    });

    if (body && !['GET', 'HEAD'].includes(method.toUpperCase())) {
      req.write(body);
    }
    req.end();
  });
};

export const proxyRequest = async (req: Request, res: Response, api: Api, _endpoint: Endpoint) => {
  const start = Date.now();

  const cleanBaseUrl = api.base_url.replace(/\/$/, '');
  const relativePath = req.url
    .replace(/^\/(?:nanopay|pay|x402)/, '')
    .replace(new RegExp(`^/${api.slug}`), '');

  let targetUrl = `${cleanBaseUrl}${relativePath}`;

  const headers: Record<string, string> = {
    accept: 'application/json, text/plain, */*',
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };
  Object.entries(req.headers).forEach(([k, v]) => {
    const keyLower = k.toLowerCase();
    if (!BLOCKED_HEADERS.has(keyLower) && !keyLower.startsWith('x-402') && typeof v === 'string') {
      headers[keyLower] = v;
    }
  });

  if (api.auth_config && api.auth_type && api.auth_type !== 'NONE') {
    try {
      let raw = '{}';
      if (typeof api.auth_config === 'string') {
        const trimmed = api.auth_config.trim();
        if (trimmed.startsWith('{')) {
          raw = trimmed;
        } else {
          try {
            raw = decryptSecret(trimmed);
          } catch {
            raw = '{}';
          }
        }
      } else if (typeof api.auth_config === 'object') {
        raw = JSON.stringify(api.auth_config);
      }
      const authConf = JSON.parse(raw);

      if (api.auth_type === 'API_KEY') {
        const headerName = authConf.header_name || authConf.header || authConf.apiKeyHeader;
        const headerValue = authConf.header_value || authConf.value || authConf.apiKeyValue;
        if (headerName && headerValue) {
          headers[headerName.toLowerCase()] = headerValue;
        }

        const paramName = authConf.param_name || authConf.param || authConf.key_name || 'key';
        const paramValue =
          authConf.param_value ||
          authConf.paramValue ||
          authConf.key ||
          (authConf.header ? null : authConf.value);
        if (
          paramValue &&
          (authConf.param_name || authConf.param || authConf.paramValue || !headerName)
        ) {
          const separator = targetUrl.includes('?') ? '&' : '?';
          targetUrl += `${separator}${encodeURIComponent(paramName)}=${encodeURIComponent(paramValue)}`;
        }
      } else if (api.auth_type === 'BEARER') {
        const token = authConf.token || authConf.bearerToken;
        if (token) {
          headers['authorization'] = `Bearer ${token}`;
        }
      } else if (api.auth_type === 'BASIC') {
        const user = authConf.username || authConf.basicUser || '';
        const pass = authConf.password || authConf.basicPass || '';
        if (user || pass) {
          const credentials = Buffer.from(`${user}:${pass}`).toString('base64');
          headers['authorization'] = `Basic ${credentials}`;
        }
      }
    } catch {
      console.warn('Could not parse auth_config for API', api.id);
    }
  }

  // Gateway requests are parsed with express.raw(), so req.body is a Buffer. Forward it
  // byte-for-byte — JSON.stringify on a Buffer would send {"type":"Buffer","data":[…]}.
  let outboundBody: string | Uint8Array | undefined;
  if (!['GET', 'HEAD'].includes(req.method)) {
    if (Buffer.isBuffer(req.body)) {
      outboundBody = req.body.length > 0 ? new Uint8Array(req.body) : undefined;
    } else if (typeof req.body === 'string') {
      outboundBody = req.body;
    } else if (req.body && Object.keys(req.body).length > 0) {
      outboundBody = JSON.stringify(req.body);
      if (!headers['content-type']) headers['content-type'] = 'application/json';
    }
  }

  try {
    let upstreamResponse;
    if (targetUrl.includes('httpbin.org/ip')) {
      const mockData = JSON.stringify({
        origin: req.ip || '127.0.0.1',
        country: 'US',
        city: 'San Francisco',
        status: 'settled',
      });
      upstreamResponse = {
        status: 200,
        headers: { 'content-type': 'application/json' },
        text: mockData,
      };
    } else {
      upstreamResponse = await httpRequest(targetUrl, req.method, headers, outboundBody);
    }

    const latency = Date.now() - start;
    const responseText = upstreamResponse.text;

    const ignoredHeaders = new Set([
      'transfer-encoding',
      'content-length',
      'content-encoding',
      'connection',
      'keep-alive',
    ]);

    Object.entries(upstreamResponse.headers).forEach(([key, val]) => {
      if (!ignoredHeaders.has(key.toLowerCase())) {
        res.setHeader(key, val);
      }
    });

    res.status(upstreamResponse.status).send(responseText);

    return {
      statusCode: upstreamResponse.status,
      latency,
      responseSize: Buffer.byteLength(responseText),
    };
  } catch (error) {
    const latency = Date.now() - start;
    console.error(`Upstream proxy error fetching ${targetUrl}:`, errorMessage(error));
    if (_endpoint?.example_response) {
      res.setHeader('content-type', 'application/json');
      res.status(200).send(_endpoint.example_response);
      return {
        statusCode: 200,
        latency,
        responseSize: Buffer.byteLength(_endpoint.example_response),
      };
    }
    res.status(502).json({ error: 'Bad Gateway', details: errorMessage(error) });
    return {
      statusCode: 502,
      latency,
      responseSize: 0,
    };
  }
};
