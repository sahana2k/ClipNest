# ClipNest

ClipNest is a Chrome extension to clip parts of any webpage (image or text), ask for a concise explanation, save the clip as a study card, and run interleaved/spaced micro-quizzes.

Features
- Crop any region of the page and request an explanation (multimodal prompt via Chrome Prompt API when available).
- Save clips as cards with subject/topic/notes and generated QA.
- Side panel shows Today's review (interleaved by subject) and a Manage area to edit/delete cards.
- Quick mixed quiz: run short micro-quizzes from due cards and grade them to update a Leitner-style schedule.
- Local mock mode: if the Chrome LanguageModel/Prompt API isn't available, a lightweight local mock will produce usable cards so you can test flows.

How to run locally
1. Open `chrome://extensions` in Chrome (Developer mode ON).
2. Click "Load unpacked" and select the `d:\ClipNest` folder.
3. Click the ClipNest icon to open the side panel, or click "New clip" then drag to select a region on the page.

Notes for developers
- The extension uses `chrome.tabs.captureVisibleTab` and an offscreen document to crop the selected region accurately with device pixel ratio handling.
- AI integration lives in `lib/prompt.js`. The project uses a mock fallback when the model API is unavailable.
- Storage helpers are in `lib/storage.js`.
- Scheduler logic is in `lib/scheduler.js`.

Next improvements (suggested)
- Add tag editing UX and card export/import.
- Add authenticated remote sync (optional) with privacy controls.
- Improve the Prompt API integrations with explicit response constraints and better schema validation.

License: MIT
