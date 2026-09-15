'use strict';
/**
 * TTS Router — picks Orpheus (Groq) when configured, otherwise browser fallback.
 */

const { OrpheusTTS } = require('./orpheus');

class TTSRouter {
  constructor({ log, settings } = {}) {
    this.log = log || { write() {} };
    this.settings = settings || null;
    this.orpheus = new OrpheusTTS({ log: this.log, settings: this.settings });
  }

  isConfigured() {
    return this.orpheus.isConfigured();
  }

  async health() {
    return {
      primary: await this.orpheus.health(),
      fallback: { id: 'browser', label: 'Browser TTS', provider: 'browser', configured: true, status: 'ok', description: 'speechSynthesis in browser' },
    };
  }

  async synthesize(text, opts) {
    if (this.orpheus.isConfigured()) {
      try {
        return await this.orpheus.synthesize(text, opts);
      } catch (e) {
        // fall through to browser fallback signal
        return { ok: false, fallback: true, error: e.message, say: text };
      }
    }
    // No cloud TTS — signal browser to speak
    return { ok: true, fallback: true, provider: 'browser', say: text };
  }
}

module.exports = { TTSRouter };
