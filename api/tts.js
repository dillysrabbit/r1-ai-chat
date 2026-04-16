// Vercel Edge Function: proxy to the ElevenLabs text-to-speech API.
//
// The R1 webview's speechSynthesis API is unreliable in the wild, so
// when the Chef turns on "Antworten vorlesen" in Settings we send the
// Claude reply here and stream MP3 bytes back to the client, which plays
// them through an <audio> element.
//
// Why ElevenLabs:
//   - multilingual (German is native, not a best-effort transliteration)
//   - Flash v2.5 model: ~75ms first-byte latency, ~$0.33 per 1M chars
//   - Streams MP3 so playback can start before generation finishes
//
// Env vars (set on Vercel):
//   - ELEVENLABS_API_KEY  (required)
//   - ELEVENLABS_VOICE_ID (optional; falls back to Rachel, a calm
//     multilingual female voice that fits the intercom framing)

export const config = {
  runtime: 'edge'
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

// Rachel — ElevenLabs' default multilingual female voice. Overridable
// via ELEVENLABS_VOICE_ID if the Chef wants a different Mrs. L.
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

// Guard rail: refuse obviously-too-long payloads before we burn API
// credits. A Claude reply over ~6k chars is almost certainly a runaway.
const MAX_CHARS = 6000;

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

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return json(500, {
      error: { message: 'ELEVENLABS_API_KEY not set on server' }
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: { message: 'Invalid JSON' } });
  }

  const text = (body.text || '').toString().trim();
  if (!text) {
    return json(400, { error: { message: 'Missing "text" field' } });
  }
  if (text.length > MAX_CHARS) {
    return json(413, {
      error: { message: 'Text too long (' + text.length + ' > ' + MAX_CHARS + ')' }
    });
  }

  const voiceId =
    (body.voice && body.voice.toString()) ||
    process.env.ELEVENLABS_VOICE_ID ||
    DEFAULT_VOICE_ID;

  const url =
    'https://api.elevenlabs.io/v1/text-to-speech/' +
    encodeURIComponent(voiceId) +
    '/stream';

  const upstream = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg'
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_flash_v2_5',
      output_format: 'mp3_44100_128'
    })
  });

  if (!upstream.ok) {
    // Surface the upstream error so the client can show a useful status.
    const errText = await upstream.text().catch(() => '');
    return json(upstream.status, {
      error: {
        message: 'ElevenLabs ' + upstream.status + ': ' + errText.slice(0, 200)
      }
    });
  }

  // Stream the MP3 straight through to the client.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store'
    }
  });
}
