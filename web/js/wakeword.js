/* Wake-word matcher (shared between the web client and the Node test suite).
   JARVIS FORK: "Jarvis" is the primary trigger; bare "hey"/"hi"/"hello" also
   wake — but ONLY when the greeting is the whole short utterance, so
   conversation full of "hey, about that…" doesn't false-trigger (sensitivity
   tuning). The MAX AI fork keeps "max" as its trigger; this fork does NOT
   wake on "max" — the two products are independent from here on. */
(function (root, factory) {
  const m = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = m;
  else root.WakeWord = m;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function match(text) {
    const said = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!said) return { wake: false };
    // primary trigger: the assistant's name, alone or with a greeting prefix
    if (/(^|\s)(hey|okay|ok|hi|hello|yo)\s+jarvis\b/.test(said) || /(^|\s)jarvis\b/.test(said)) return { wake: true, kind: 'name' };
    // catch-all greeting: only a bare, short greeting — nothing tacked on
    if (/^(hey|hi|hello)[\s.!]*$/.test(said) && said.length <= 12) return { wake: true, kind: 'greeting' };
    return { wake: false };
  }
  return { match };
});
