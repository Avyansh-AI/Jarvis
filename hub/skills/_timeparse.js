'use strict';
/** Natural-language time helpers shared by clock/reminder/calendar skills. */

const SINGULAR = {
  second: 1000, sec: 1000,
  minute: 60000, min: 60000,
  hour: 3600000, hr: 3600000,
  day: 86400000,
  week: 604800000,
};

/** "5 minutes", "an hour", "90 seconds", "1 and a half hours" -> ms | null */
function parseDuration(text) {
  const t = String(text).toLowerCase();
  let total = 0, found = false, m;
  const re = /(an?|half(?:\s+an?)?|(\d+(?:\.\d+)?))\s*(second|sec|minute|min|hour|hr|day|week)s?/g;
  while ((m = re.exec(t))) {
    found = true;
    const n = m[2] !== undefined ? parseFloat(m[2]) : (m[1].startsWith('half') ? 0.5 : 1);
    total += n * SINGULAR[m[3]];
  }
  return found && total > 0 ? total : null;
}

const DOW = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

/**
 * Absolute-ish time from text: "at 7", "at 7:30pm", "tomorrow at 8 am",
 * "on friday at 3", "noon", "midday", "tomorrow morning/evening".
 * Returns { at, hour, minute, dow|null } | null
 */
function parseAt(text, now = new Date()) {
  const t = ' ' + String(text).toLowerCase() + ' ';
  let hour = null, minute = 0;

  if (/\b(noon|midday)\b/.test(t)) { hour = 12; }
  else if (/\bmidnight\b/.test(t)) { hour = 0; }
  else {
    const hm = t.match(/\b(?:at|for|around)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
    if (hm && !/^\s*(?:at|for|around)?\s*$/.test(hm[0])) {
      hour = parseInt(hm[1], 10);
      minute = hm[2] ? parseInt(hm[2], 10) : 0;
      const ap = hm[3] ? hm[3].toLowerCase() : null;
      if (ap === 'pm' && hour < 12) hour += 12;
      if (ap === 'am' && hour === 12) hour = 0;
      if (!ap) {
        if (/(afternoon|evening|night|dinner|pm-ish)/.test(t) && hour < 12) hour += 12;
        else if (!/(tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|wake|alarm|breakfast)/.test(t) && hour <= now.getHours()) hour += 12;
      }
      if (hour > 23) return null;
    }
  }
  if (hour === null) return null;
  if (/(morning)/.test(t) && hour >= 12) hour -= 12;
  if (/evening|night/.test(t) && hour < 12) hour += 12;

  const when = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  let dow = null;
  for (const [name, idx] of Object.entries(DOW)) {
    if (new RegExp(`\\b${name}\\b`).test(t)) { dow = idx; break; }
  }
  if (/\btomorrow\b/.test(t)) when.setDate(when.getDate() + 1);
  else if (dow !== null) {
    let guard = 0;
    while ((when.getDay() !== dow || when.getTime() < now.getTime()) && guard++ < 8) when.setDate(when.getDate() + 1);
  } else if (when.getTime() < now.getTime()) when.setDate(when.getDate() + 1);

  return { at: when.getTime(), hour, minute: when.getMinutes(), dow };
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.round(m / 60);
  return `${h} hour${h === 1 ? '' : 's'}`;
}

function fmtTime(atMs) {
  return new Date(atMs).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function fmtDayTime(atMs) {
  const d = new Date(atMs);
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const label = d.toDateString() === today.toDateString() ? ''
    : d.toDateString() === tomorrow.toDateString() ? 'tomorrow '
    : d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }) + ' ';
  return label + fmtTime(atMs);
}

module.exports = { parseDuration, parseAt, fmtDuration, fmtTime, fmtDayTime, DOW };
