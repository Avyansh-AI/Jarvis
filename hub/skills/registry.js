'use strict';
/**
 * Skill registry — the plugin pattern behind every capability.
 *
 * A skill is a CommonJS module in this folder exporting:
 * {
 *   name: 'weather',            // unique id (defaults to filename)
 *   label: 'Weather',           // human name
 *   description: '…',
 *   version: '1.0.0',
 *   defaultEnabled: true,
 *   priority: 0,                // higher = earlier intent match
 *   sensitive: false,           // true → requires voice verification
 *   personalData: false,        // true → blocked for guest profiles
 *   kidBlocked: false,          // true → blocked for child profiles
 *   intents: [                  // deterministic offline routing
 *     { patterns: [/weather in (\w+)/i], run: async (match, text, ctx) => ({ say }) },
 *   ],
 *   tools: [                    // LLM tool-use (JSON schema; sent to OpenRouter as functions)
 *     { name, description, input_schema, run: async (args, ctx) => ({ say }) },
 *   ],
 *   init?: async (ctx) => {},   // called once at boot
 *   continueTask?: (task, text, ctx) => ({ say, done })  // multi-turn tasks
 * }
 *
 * Dropping a new .js file in this folder registers it automatically —
 * that is the "marketplace" install path (see docs/ADDING_A_SKILL.md).
 */
const fs = require('fs');
const path = require('path');

class Registry {
  constructor(settings, log) {
    this.settings = settings;
    this.log = log;
    this.skills = new Map();
  }

  load(dir = __dirname) {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'registry.js' && !f.startsWith('_')).sort();
    for (const f of files) {
      try {
        const mod = require(path.join(dir, f));
        const skill = { name: f.replace(/\.js$/, ''), priority: 0, ...mod };
        this.skills.set(skill.name, skill);
      } catch (e) {
        this.log.write('error', { message: `skill ${f} failed to load: ${e.message}` });
        console.error(`[skills] ${f}:`, e.message);
      }
    }
    console.log(`[skills] loaded ${this.skills.size}: ${[...this.skills.keys()].join(', ')}`);
  }

  enabled(skill) {
    return this.settings.data.skills[skill.name] !== false && skill.defaultEnabled !== false;
  }

  get(name) { return this.skills.get(name) || null; }

  /** First matching intent across enabled skills, priority-ordered. */
  match(text) {
    const ordered = [...this.skills.values()].filter((s) => this.enabled(s)).sort((a, b) => (b.priority || 0) - (a.priority || 0));
    for (const skill of ordered) {
      for (const intent of skill.intents || []) {
        for (const re of intent.patterns || []) {
          const m = text.match(re);
          if (m) return { skill, intent, match: m };
        }
      }
    }
    return null;
  }

  /** Tool definitions (JSON schema) from enabled skills — wrapped as OpenAI functions for OpenRouter. */
  toolDefs() {
    const defs = [];
    for (const skill of this.skills.values()) {
      if (!this.enabled(skill)) continue;
      for (const t of skill.tools || []) {
        defs.push({ name: t.name, description: t.description, input_schema: t.input_schema });
      }
    }
    return defs;
  }

  tool(name) {
    for (const skill of this.skills.values()) {
      if (!this.enabled(skill)) continue;
      for (const t of skill.tools || []) {
        if (t.name === name) return { skill, run: t.run, schema: t.input_schema || null, sideEffect: t.sideEffect || null, confirm: t.confirm || null };
      }
    }
    return null;
  }

  describe() {
    return [...this.skills.values()].map((s) => ({
      name: s.name, label: s.label || s.name, description: s.description || '',
      version: s.version || '1.0.0', enabled: this.enabled(s),
      sensitive: !!s.sensitive, personalData: !!s.personalData, kidBlocked: !!s.kidBlocked,
      intents: (s.intents || []).length, tools: (s.tools || []).length,
    }));
  }
}

module.exports = { Registry };
