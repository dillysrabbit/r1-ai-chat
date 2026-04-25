# Rabbit R1 Creation Development

## Trigger
Use this skill when writing, reviewing, or debugging code that runs inside a Rabbit R1 Creation (the R1's WebView-based app platform). Applies when files reference R1-specific APIs like `CreationVoiceHandler`, `PluginMessageHandler`, `closeWebView`, `TouchEventHandler`, `window.creationStorage`, `window.creationSensors`, or when the viewport is 240x282.

## Platform Constraints

### Screen
- Fixed viewport: **240x282 px**. Design for this, not the browser.
- Viewport meta: `width=240, initial-scale=1.0, user-scalable=no`
- `body { width: 240px; height: 282px; overflow: hidden; }` — no scrollable body.
- Implement your own scroll logic with `translateY` or overflow on inner containers.

### Rendering
- **No WebGL** — Flutter WebView doesn't support it. Canvas 2D only.
- **No external fonts** — `@import url(fonts.googleapis.com/...)` won't load reliably. Inline fonts as base64 `@font-face` data URIs, or use `-apple-system, sans-serif`.
- Prefer hardware-accelerated CSS: `transform` and `opacity` over `top`/`left`/`width`.
- Use CSS transitions instead of JS animations wherever possible.
- Minimise DOM operations — batch updates, avoid layout thrash.

### Event Model
- **Never use `onclick` in innerHTML** — silent failures in the WebView. Always use `addEventListener`.
- Use `pointerdown`/`pointerup` instead of `touchstart`/`touchend`.
- **Never call `e.preventDefault()`** in item interaction chains — causes crashes after ~3 seconds.
- Native `window.confirm()` / `window.alert()` may not render or may block the JS thread. Build in-app overlay dialogs instead.

### Fonts & Sizing
- Default font: `-apple-system, sans-serif` (or inline a specific font).
- Font sizes: brand/label 10px, secondary 11px, list items 12-13px, primary 14-18px.
- Default dark background: `#0e0e10`. Default accent: `#FE5000` (R1 brand orange).

## R1 Native Events

All dispatched on `window`:

```js
window.addEventListener('sideClick', fn)      // side button single press
window.addEventListener('longPressStart', fn)  // long press begins
window.addEventListener('longPressEnd', fn)    // long press released
window.addEventListener('scrollUp', fn)        // scroll wheel up
window.addEventListener('scrollDown', fn)      // scroll wheel down
```

**Double-click note**: Two `sideClick` events fire ~50ms apart. Debounce if distinguishing single vs double.

Always add keyboard fallbacks for desktop testing:

```js
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape')    window.dispatchEvent(new Event('sideClick'));
  if (e.key === 'ArrowUp')   window.dispatchEvent(new Event('scrollUp'));
  if (e.key === 'ArrowDown') window.dispatchEvent(new Event('scrollDown'));
  if (e.key === ' ' && !e.repeat) window.dispatchEvent(new Event('longPressStart'));
});
document.addEventListener('keyup', function(e) {
  if (e.key === ' ') window.dispatchEvent(new Event('longPressEnd'));
});
```

## Voice Input — CreationVoiceHandler (Preferred)

Native R1 bridge. Much faster and more accurate than MediaRecorder + external STT. No CDN, no tokens, no WebSocket, no `getUserMedia` permission prompt, no conflict with the R1's PTT hardware button.

```js
// Guard
function hasCreationVoice() {
  return typeof CreationVoiceHandler !== 'undefined'
    && CreationVoiceHandler
    && typeof CreationVoiceHandler.postMessage === 'function';
}

// Start recording
CreationVoiceHandler.postMessage('start');

// Stop recording
CreationVoiceHandler.postMessage('stop');

// Receive transcript
window.onPluginMessage = function(data) {
  if (data.type !== 'sttEnded') return;
  var transcript = (data.transcript || '').trim();
  // use transcript...
};
```

**Best pattern**: `longPressStart` -> start, `longPressEnd` -> stop (hold-to-talk). Guard against double-firing with a state flag.

**Fallback**: Keep a `MediaRecorder` + server-side Whisper path for desktop browsers and older R1 firmware that lacks the bridge. Use a `voiceMode` state machine (`idle` | `native` | `media`) so the two pipelines can't overlap.

### What DOESN'T work for voice on R1
- `window.speechSynthesis` (Web Speech API TTS) — the R1 ships without a TTS engine; calls are silently no-op.
- `webkitSpeechRecognition` — not available.
- `getUserMedia` can conflict with the R1's hardware PTT button.

## Storage

### localStorage (simple, works)
```js
localStorage.setItem('key', JSON.stringify(data));
var data = JSON.parse(localStorage.getItem('key') || 'null');
```

### window.creationStorage (survives app reinstalls)
Data must be Base64-encoded. Storage is isolated per plugin ID.

```js
// Check availability
function hasCreationStorage() {
  return typeof window !== 'undefined'
    && window.creationStorage
    && window.creationStorage.plain;
}

// Plain storage (unencrypted)
await window.creationStorage.plain.setItem('key', btoa(JSON.stringify(data)));
const raw = await window.creationStorage.plain.getItem('key');
const data = raw ? JSON.parse(atob(raw)) : null;

// Secure storage (hardware-encrypted, Android M+)
await window.creationStorage.secure.setItem('api_key', btoa('secret'));
const secret = atob(await window.creationStorage.secure.getItem('api_key'));
```

**Important**: The old `CreationStorageHandler.postMessage(...)` API is broken (fire-and-forget, getItem returns nothing). Use `window.creationStorage.plain` / `.secure` instead.

## LLM Integration — PluginMessageHandler

Send messages to the R1's built-in LLM. Response arrives via `window.onPluginMessage`.

```js
PluginMessageHandler.postMessage(JSON.stringify({
  message: "Your prompt here",
  useLLM: true,                // route through R1's LLM
  wantsR1Response: true,       // R1 speaks response aloud
  wantsJournalEntry: false     // log to journal
}));
```

**Critical**: `useLLM: true` uses the R1's own LLM, NOT an external provider like Claude/OpenAI. Don't mix this with your own API proxy. `wantsR1Response` only works with `useLLM: true`.

Response handling:
```js
window.onPluginMessage = function(data) {
  if (data.data) {
    try { var parsed = JSON.parse(data.data); } catch(e) {}
  }
  // For STT: data.type === 'sttEnded', data.transcript
};
```

## Native Bridges

### closeWebView — Exit to Home
```js
function hasCloseWebView() {
  return typeof closeWebView !== 'undefined'
    && closeWebView
    && typeof closeWebView.postMessage === 'function';
}
closeWebView.postMessage('');
```

### TouchEventHandler — Programmatic Touch
```js
TouchEventHandler.postMessage(JSON.stringify({ type: 'tap', x: 120, y: 141 }));
// types: 'tap', 'down', 'up', 'move'
```

### Accelerometer — window.creationSensors
```js
const ok = await window.creationSensors.accelerometer.isAvailable();
window.creationSensors.accelerometer.start(function(data) {
  // data.x, data.y, data.z — normalized -1 to 1
}, { frequency: 60 }); // 10 / 30 / 60 / 100 Hz
window.creationSensors.accelerometer.stop();
```

**Fallback** for shake detection: `DeviceMotionEvent` with `accelerationIncludingGravity` (jerk magnitude > 8 m/s^2 for a reliable shake).

## Keyboard Input / Edit Screens

The R1 WebView supports the keyboard IF you use the right event model:

- Use `pointerdown`/`pointerup`, NOT `touchstart`/`touchend`.
- Do NOT call `e.preventDefault()`.
- Call `textarea.focus()` after making an edit screen visible — keyboard opens automatically.
- Call `textarea.blur()` on close — keyboard dismisses.

**Alternative for R1 without soft keyboard**: SMS-style multitap keypad (see this project's `#keypadScreen` for a working implementation). Classic Nokia T9-layout with German umlauts on appropriate keys (2=abcae, 6=mnoo, 7=pqrss, 8=tuvu).

## Deployment & Cache Busting

- Each creation is a plain HTML file. Any static host works (Netlify, GitHub Pages, own server).
- **The R1 caches creations by URL.** Bump `?v=N` in `install.html` to force a fresh install.
- The `index.html` itself is NOT cached between loads — only the install URL.
- HTTPS required for mic access.
- Self-contained: inline all CSS and JS. CDN `<script>` tags are fine but offline-unfriendly.

## QR / install.html

```js
var qrData = JSON.stringify({
  title: "My Creation",
  url: "https://domain.com/slug/?v=1",
  description: "What it does",
  iconUrl: "",
  themeColor: "#FE5000"  // card colour in the R1 app stack
});
```

## Common Patterns

### Multi-page with sideClick
```js
var pages = ['Chat', 'Sessions', 'Settings'];
var currentPage = 0;
window.addEventListener('sideClick', function() {
  currentPage = (currentPage + 1) % pages.length;
  render();
});
```

### Manual scroll with translateY
```js
var scrollOffset = 0;
function doScroll(delta) {
  var max = Math.max(0, contentHeight() - viewHeight());
  scrollOffset = Math.min(max, Math.max(0, scrollOffset + delta));
  content.style.transform = 'translateY(-' + scrollOffset + 'px)';
}
window.addEventListener('scrollUp',   function() { doScroll(-30); });
window.addEventListener('scrollDown', function() { doScroll(30); });
```

### Theming with CSS Custom Properties
```js
document.documentElement.style.setProperty('--accent', '#FF9EBB');
```

## Known Pitfalls

| Approach | Problem | Solution |
|---|---|---|
| `touchstart` + `preventDefault` on items | Crashes after ~3s | Use `pointerdown`/`pointerup`, no `preventDefault` |
| `onclick` in innerHTML strings | Silent failures | Always `addEventListener` |
| Old `CreationStorageHandler.postMessage` | Fire-and-forget, getItem broken | Use `window.creationStorage.plain`/`.secure` |
| External Google Fonts | Won't load reliably, offline-unfriendly | Inline as base64 WOFF2 `@font-face` |
| `window.confirm()` / `window.alert()` | May not render or blocks thread | Build in-app overlay dialog |
| `window.speechSynthesis` (TTS) | No TTS engine on R1, silently fails | Use server-side TTS or skip |
| `webkitSpeechRecognition` | Not available | Use `CreationVoiceHandler` |
| `getUserMedia` + R1 PTT button | Conflict / permission issues | Use `CreationVoiceHandler` |
| LiveKit + Deepgram STT | Fragmented transcripts, complex setup | Use `CreationVoiceHandler` |

## Source Documentation
Based on hard-won learnings from this project plus the community-maintained reference at `andr3w-hilton/rabbit-r1-creations-public/R1_CREATION_TIPS.md`.
