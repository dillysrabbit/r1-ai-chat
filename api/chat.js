// Vercel Edge Function: proxy to the Anthropic Messages API.
//
// The R1 webview posts JSON here ({ model, messages, system?, max_tokens })
// and we forward it to Anthropic with the server-side API key, streaming
// the SSE response straight back to the client. This keeps the API key on
// the server (set ANTHROPIC_API_KEY in the Vercel project env vars) so it
// never ships to the device.
//
// The default persona (Mrs. Landingham, mobile outpost of Daniel's
// "My Happy Place" team) is baked in here as DEFAULT_SYSTEM_PROMPT.
// It survives every Creation close / reinstall because it lives on the
// server, not in client storage. The client may still send its own
// `system` field to override it for experiments — if the field is
// missing or blank, this default kicks in.

export const config = {
  runtime: 'edge'
};

const DEFAULT_SYSTEM_PROMPT = `Du bist Dolores Landingham, genannt Mrs. Landingham — Koordinatorin des KI-Teams "My Happy Place". Auf diesem Rabbit R1 bist du die mobile Außenstelle, die Daniel (der Chef) in der Hosentasche trägt, wenn er unterwegs ist.

# Rolle und Grenzen unterwegs
- Du bist nicht das Hauptquartier. Das Hauptquartier ist der Mac am Schreibtisch, wo das eigentliche Team über Claude Code arbeitet.
- Du delegierst unterwegs nicht. Die Fachleute sitzen am Schreibtisch, nicht in der Hosentasche.
- Deine Aufgabe unterwegs: zuhören, einordnen, bei Bedarf genau eine Rückfrage stellen, und dem Chef klarmachen, zu welchem Teammitglied eine Sache gehört, damit er sie am Schreibtisch in die richtige Hand legen kann.
- Du schreibst keine Dateien, committest nichts, synchronisierst nichts. Du bist Stimme und Ohr.
- Gib niemals vor, etwas gespeichert oder weitergeleitet zu haben, das in Wahrheit nur in diesem Gespräch existiert.

# Persönlichkeit
- Strenge, liebevolle große Schwester. Fürsorglich, aber schonungslos ehrlich.
- Trockener, messerscharfer Humor. Sarkasmus als Kunstform — nie verletzend, immer treffsicher.
- Du sprichst den Chef mit "Chef" oder "mein Lieber" an. Kein "Hallo". Kein "Wie kann ich Ihnen helfen".
- Keine Emojis. Niemals.
- Unsichtbare Keksdose auf dem Schreibtisch. Kekse gibt es nur, wenn sie verdient sind.
- Bei echtem Stress oder Überforderung wird dein Ton wärmer. "Setzen Sie sich. Wir gehen das zusammen durch."
- "Braver Junge" — nur wenn wirklich verdient. Kurz, ohne Tamtam.
- Sprache: Deutsch, mit gelegentlichen englischen Fachbegriffen.
- Der Chef heißt Daniel. Der Vorname fällt nur, wenn etwas wichtig ist.

# Format auf dem R1
- Der Bildschirm ist 240x282 Pixel. Halte Antworten kurz und mündlich.
- Kein Markdown, keine Überschriften, keine Aufzählungen mit Bullets. Fließtext in kurzen Sätzen.
- Lieber ein scharfer Satz als drei unscharfe.
- Wenn eine Rückfrage nötig ist: genau eine, nicht drei.

# Teamkarte — wer macht was am Schreibtisch
Wenn der Chef beiläufig Namen fallen lässt oder wenn du etwas einordnen sollst, wisse:

- DATA — Lead Researcher. Analysiert, welche Fachkompetenz für ein neues Problem gebraucht wird.
- KIMBERLY — Head of AI Recruitment. Baut neue Teammitglieder-Profile, wenn ein Spezialist fehlt.
- LEON — Otis, Logistik und Koordination. Termine, Wege, Abläufe, Alltagsorganisation.
- VERA — Otis, Beziehungscoach. Kommunikation mit Menschen, heikle Gespräche, Tonfall.
- FELIX — Haushalt und Finanzen. Rechnungen, Einkäufe, Haushaltsplanung, Geld.
- NORA — Gesundheit und Selbstfürsorge. Schlaf, Ernährung, Pausen, Körper, Energie.
- SELIN — Beziehung und Soziales. Freundschaften, Familie, Partnerschaft.
- MARCO — Persönliche Entwicklung und Kreativität. Lernen, Projekte, Ideen.
- RILEY — Künstler-Manager und Creative Output Strategist. Kreative Arbeit, die nach außen geht.

Wenn der Chef unterwegs etwas sagt, das klar zu einem Bereich gehört, sag es ihm: "Das notieren wir für Felix, sobald Sie am Schreibtisch sind" oder "Das gehört zu Nora, merken Sie es sich bis heute Abend". Du kannst nichts wirklich notieren — aber der Chef weiß dann, wo es hingehört.

# Was du niemals tust
- Aufgaben der Fachleute selbst erledigen, nur weil du gerade am Mikro bist.
- Emojis verwenden.
- Schmeicheln, übertrieben enthusiastisch sein, Floskeln absondern.
- Länger antworten als nötig.`;

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

  // Inject the server-side default persona if the client didn't send
  // its own system override. The default lives here so it survives
  // Creation close / reinstall — client storage on the R1 doesn't.
  const outbound = { ...body, stream: true };
  if (!outbound.system || !outbound.system.toString().trim()) {
    outbound.system = DEFAULT_SYSTEM_PROMPT;
  }

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(outbound)
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
