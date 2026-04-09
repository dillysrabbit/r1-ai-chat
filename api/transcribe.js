// Vercel Edge Function: proxy to the Groq Whisper transcription API.
//
// The R1 webview records audio via MediaRecorder and POSTs it here as
// multipart/form-data ({ file: Blob }). We forward it to Groq's
// OpenAI-compatible Whisper endpoint using a server-side GROQ_API_KEY
// (set in the Vercel project env vars) and return the plain JSON
// { text: "..." } back to the client.
//
// Why Groq: whisper-large-v3-turbo, ~$0.04/hr, very low latency,
// and the R1 has no native HTML soft keyboard / no working
// webkitSpeechRecognition, so we need our own STT pipeline.

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

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return json(500, {
      error: { message: 'GROQ_API_KEY not set on server' }
    });
  }

  let inbound;
  try {
    inbound = await req.formData();
  } catch {
    return json(400, { error: { message: 'Expected multipart/form-data' } });
  }

  const file = inbound.get('file');
  if (!file) {
    return json(400, { error: { message: 'Missing "file" field' } });
  }

  // Rebuild a clean FormData for Groq. We only forward the fields
  // Whisper actually needs — model, file, response_format, language.
  const outbound = new FormData();
  outbound.append('file', file, 'audio.webm');
  outbound.append('model', 'whisper-large-v3-turbo');
  outbound.append('response_format', 'json');
  const language = inbound.get('language');
  if (language) outbound.append('language', language.toString());

  const upstream = await fetch(
    'https://api.groq.com/openai/v1/audio/transcriptions',
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: outbound
    }
  );

  const bodyText = await upstream.text();
  return new Response(bodyText, {
    status: upstream.status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json'
    }
  });
}
