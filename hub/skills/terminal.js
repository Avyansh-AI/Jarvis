'use strict';
/** Terminal — "terminal" / "open terminal". A special local intent, deliber-
 *  ately OUTSIDE the LLM path and outside the generic app-launcher: it is the
 *  ONE AND ONLY app path that opens Jarvis Remote (the dashboard). Full-utterance
 *  match only, so "open the terminal app for me" still falls through to the
 *  normal apps skill. Never fires on boot. Regression-verified in
 *  tools/test-features.js (no other dashboard-open exists anywhere). */
module.exports = {
  name: 'terminal',
  label: 'Terminal',
  description: 'Say "terminal" to open Jarvis Remote (the dashboard).',
  priority: 10, // must outrank the apps skill's generic `open X` launcher
  intents: [
    {
      patterns: [/^\s*(?:open\s+)?terminal\s*$/i],
      run: async () => ({ say: 'Opening the terminal — Jarvis Remote is on your screen.', open: 'dashboard.html' }),
    },
  ],
};
