'use strict';
/**
 * Orpheus TTS via Groq
 *
 * Groq's ultra-low-latency TTS endpoint with the Orpheus voice model.
 * Falls back to browser speechSynthesis when Groq is not configured.
 *
 * Env:
 *   GROQ_API_KEY         – required for cloud TTS
 *   GROQ_TTS_MODEL       – default "orpheus" (or "playai-tts", "canopylabs/orpheus-3b-0.1-ft")
 *   GROQ_TTS_VOICE       – voice id, default "tara" (Orpheus voices: tara, leah, jess, leo, dan, mia, zac, zoe)
 *   GROQ_TTS_URL         – override, default https://api.groq.com/openai/v1/audio/speech
 */

const { http } = require('../net');

const DEFAULT_MODEL = 'canopylabs/orpheus-3b-0.1-ft';
const DEFAULT_VOICE = 'tara';
const DEFAULT_URL = 'https://api.groq.com/openai/v1/audio/speech';

class OrpheusTTS {
  constructor({ log, settings } = {}) {
    this.id = 'tts';
    this.label = 'TTS';
    this.model = (settings && settings.data.groq && settings.data.groq.model) || process.env.GROQ_TTS_MODEL || process.env.TTS_MODEL || DEFAULT_MODEL;
    this.voice = (settings && settings.data.groq && settings.data.groq.voice) || process.env.GROQ_TTS_VOICE || process.env.TTS_VOICE || DEFAULT_VOICE;
    this.provider = 'groq';
    this.log = log || { write() {} };
    this.settings = settings || null;
    this._lastOk = 0;
    this._lastFail = null;
  }

  _effectiveKey() {
    try {
      const { effectiveGroqKeys } = require('../keyring');
      const list = effectiveGroqKeys(this.settings ? this.settings.data : null);
      if (list.length) return list[0];
    } catch {}
    return process.env.GROQ_API_KEY || '';
  }

  isConfigured() {
    const k = this._effectiveKey();
    return !!(k && k.trim());
  }

  async health() {
    return {
      id: this.id,
      label: this.label,
      model: this.model,
      voice: this.voice,
      provider: this.provider,
      configured: this.isConfigured(),
      lastOk: this._lastOk || null,
      lastFail: this._lastFail,
      status: this.isConfigured() ? (this._lastFail && Date.now() - this._lastFail.at < 60000 ? 'degraded' : 'ok') : 'no-keys',
    };
  }

  // Browser-side fallback is handled in web/js — this is the hub-side cloud path
  async synthesize(text, { voice, model, format = 'mp3' } = {}) {
    const apiKey = this._effectiveKey();
    if (!apiKey) throw new Error('Groq TTS not configured (GROQ_API_KEY)');

    const url = (process.env.GROQ_TTS_URL || DEFAULT_URL).replace(/\/$/, '');
    const body = {
      model: model || this.model,
      voice: voice || this.voice,
      input: String(text || '').slice(0, 4000),
      response_format: format,
    };

    try {
      const res = await http(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + apiKey,
        },
        body: JSON.stringify(body),
      }, 15000);

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        const err = new Error('Groq TTS HTTP ' + res.status + (errText ? ': ' + errText.slice(0, 200) : ''));
        err.status = res.status;
        this._lastFail = { at: Date.now(), status: res.status, reason: errText.slice(0, 120) };
        throw err;
      }

      // Return audio buffer + metadata; caller can stream to client or save
      const buf = Buffer.from(await res.arrayBuffer());
      this._lastOk = Date.now();
      this._lastFail = null;
      this.log.write('tts.ok', { model: body.model, voice: body.voice, chars: body.input.length, bytes: buf.length });
      return { ok: true, audio: buf, format, model: body.model, voice: body.voice };
    } catch (e) {
      this.log.write('tts.fail', { error: e.message });
      this._lastFail = { at: Date.now(), reason: e.message };
      throw e;
    }
  }

  // For the /api/tts endpoint: returns a data URL or streams
  async synthesizeToDataUrl(text, opts) {
    const out = await this.synthesize(text, opts);
    const mime = out.format === 'mp3' ? 'audio/mpeg' : out.format === 'wav' ? 'audio/wav' : 'audio/' + out.format;
    const b64 = out.audio.toString('base64');
    return { ...out, dataUrl: `data:${mime};base64,${b64}` };
  }
}

module.exports = { OrpheusTTS, DEFAULT_MODEL, DEFAULT_VOICE, DEFAULT_URL };
