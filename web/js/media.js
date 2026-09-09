'use strict';
/**
 * Media control — play/pause/skip/volume.
 * Ships with a configurable webhook bridge (works with anything: Spotify via a
 * local player daemon, MPD, Kodi, Home Assistant media players). Without a hook
 * it keeps a local virtual player state so the UI stays truthful.
 */
const { storeFor } = require('../skill-data');

function player() {
  const st = storeFor('media');
  st.data.player = st.data.player || { playing: false, volume: 40, track: null };
  return st;
}

async function dispatch(ctx, action, value) {
  const hook = ctx.settings.mediaHook;
  if (hook) {
    try {
      await fetch(hook, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, value: value ?? null, at: Date.now() }),
      });
    } catch (e) { return { note: 'hook unreachable', error: e.message }; }
  }
  return { note: hook ? 'sent to hook' : 'virtual player only' };
}

async function control(ctx, action, value) {
  const p = player().data.player;
  switch (action) {
    case 'play': p.playing = true; break;
    case 'pause': case 'stop': p.playing = false; break;
    case 'next': case 'previous': break;
    case 'volume_up': p.volume = Math.min(100, p.volume + 10); break;
    case 'volume_down': p.volume = Math.max(0, p.volume - 10); break;
    case 'volume': p.volume = Math.max(0, Math.min(100, Number(value) || 0)); break;
  }
  player().save();
  const d = await dispatch(ctx, action, value);
  return { p, note: d.note };
}

module.exports = {
  name: 'media',
  label: 'Media & Apps',
  description: 'Playback control (play/pause/next/volume) via webhook bridge or virtual player.',
  control,
  intents: [
    {
      patterns: [/^\s*(play|pause|resume|stop)( the)?( music| playback)?\s*$/i, /\b(next|previous|skip) (track|song)\b/i, /\bvolume (up|down)\b/i, /\b(?:set )?volume (?:to )?(\d{1,3})\b/i],
      run: async (m, text, ctx) => {
        let action = 'play', value = null;
        if (/^play|resume/i.test(text)) action = 'play';
        else if (/^pause|^stop/i.test(text)) action = 'pause';
        else if (/next|skip/i.test(text)) action = 'next';
        else if (/previous/i.test(text)) action = 'previous';
        else if (/volume up/i.test(text)) action = 'volume_up';
        else if (/volume down/i.test(text)) action = 'volume_down';
        else if (m[1]) { action = 'volume'; value = parseInt(m[1], 10); }
        const { p, note } = await control(ctx, action, value);
        const say = action.startsWith('volume')
          ? `Volume ${action === 'volume' ? 'set to ' + p.volume : p.volume + ' percent'}.`
          : action === 'play' ? 'Playing.' : action === 'pause' ? 'Paused.' : 'Skipping.';
        return { say: say + (note === 'virtual player only' ? '' : ''), data: { player: p } };
      },
    },
    {
      patterns: [/\bwhat('?s| is) playing\b/i],
      run: async (m, text, ctx) => {
        const p = player().data.player;
        return { say: p.playing ? `Playing${p.track ? ' ' + p.track : ''} at volume ${p.volume}.` : 'Nothing is playing right now.' };
      },
    },
  ],
  tools: [
    {
      name: 'media_control',
      description: 'Control media playback or volume.',
      input_schema: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['play', 'pause', 'next', 'previous', 'volume_up', 'volume_down', 'volume'] }, value: { type: 'number' } },
        required: ['action'],
      },
      run: async ({ action, value }, ctx) => {
        const { p } = await control(ctx, action, value);
        return { say: action === 'volume' || action.includes('volume') ? `Volume ${p.volume}%.` : 'Done.', data: { player: p } };
      },
    },
  ],
};
