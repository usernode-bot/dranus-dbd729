# DRANUS: Studio Drama Pendek

A mobile-first studio for making short drama films, from an idea to a
playable video, in the browser. The UI is Indonesian by default with an
English toggle.

## What it does

A six-step wizard with a progress bar:

1. **Ide**: title, genre, target length (1, 3 or 5 minutes), tone, dialogue
   language and a one-sentence premise. "Beri Saya Ide" offers 5 premises.
2. **Tokoh**: 2 to 5 characters, each with a real portrait photo picked from
   a gallery (filter by gender and age), relationships and a voice (gender,
   pitch, speed). The photos live in `public/faces`, credited in
   `public/faces/LICENSE.md`.
3. **Naskah**: a three-act script split into scenes with location, time,
   mood, action and dialogue lines. Reorder by drag or up/down buttons.
   "Tulis Otomatis" drafts a script. A script checker and a duration
   estimate stay visible.
4. **Storyboard**: each scene becomes shots (wide, medium, close-up) with a
   camera move and transition; the characters' photos stand, with soft
   edges, over an illustrated location background.
5. **Suara & Musik**: per-character speech (Web Speech API), an optional
   narrator, generated background music and sound effects (WebAudio).
6. **Putar & Ekspor**: a canvas player with title card, camera moves,
   transitions, subtitles and credits, a draggable timeline, 16:9 or 9:16,
   and WebM export through MediaRecorder.

Projects can be duplicated, deleted and exported or imported as JSON. Six
built-in templates play straight away, including a Chinese imperial palace
drama ("Rahasia di Istana Terlarang").

## How it is built

- `public/index.html` is the whole app: one file with inline CSS and JS. It
  loads the platform's centrally hosted bridge and native UI kit by relative
  path, plus the precompiled `/tailwind.css`.
- Projects are stored in the browser's `localStorage`, namespaced per
  Homeroom user. There are no database tables yet.
- `server.js` serves the app and two AI routes. `/api/ai/status` reports
  whether the platform LLM proxy is available and `/api/ai/generate` asks it
  for premises or a script draft. Without the proxy (staging, local runs) the
  app uses its built-in offline generator.

Run locally with `npm ci && npm run build && npm start`.
