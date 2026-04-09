// Vercel Edge Function: proxy to the Anthropic Messages API.
//
// The R1 webview posts JSON here ({ model, messages, system?, max_tokens })
// and we forward it to Anthropic with the server-side API key, streaming
// the SSE response straight back to the client. This keeps the API key on
// the server (set ANTHROPIC_API_KEY in the Vercel project env vars) so it
// never ships to the device.

export const config = {
  runtime: 'edge'
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json(405, { error: { message: 'Method not allowed' } });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json(500, {
      error: { message: 'ANTHROPIC_API_KEY not set on server' }
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: { message: 'Invalid JSON body' } });
  }

  if (!body || !body.model || !Array.isArray(body.messages)) {
    return json(400, { error: { message: 'Missing model or messages' } });
  }

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ ...body, stream: true })
  });

  if (!upstream.ok) {
    const errText = await upstream.text();
    return new Response(errText, {
      status: upstream.status,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
  }

  // Stream SSE response straight through to the client.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive'
    }
  });
}
