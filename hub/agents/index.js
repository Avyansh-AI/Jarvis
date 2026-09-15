'use strict';
/**
 * Jarvis Multi-Agent System — Host + Sub-agents + Fallback
 *
 * Implements the diagram:
 *   Jarvis (Multi-agent assistant)
 *     ├─ Host      → gpt-oss-120b (OpenRouter, 3-key)
 *     ├─ Sub-agents → Qwen3.6-27b (5 accounts)
 *     ├─ TTS       → Orpheus (Groq)
 *     └─ Fallback  → Gemini (3-key overflow)
 *
 * This module is the brain router that the main Orchestrator delegates to.
 * It keeps the same external interface (_llm, _ollamaChat) but internally
 * follows the map.
 */

const { HostAgent } = require('./host');
const { SubAgentsPool } = require('./subAgents');
const { FallbackAgent } = require('./fallback');
const { AGENT_MAP, listAgents, modelLadder } = require('../config/agents');

class MultiAgentSystem {
  constructor({ settings, log, net, ollama } = {}) {
    this.settings = settings;
    this.log = log || { write() {} };
    this.net = net || { online: true };
    this.ollama = ollama || null;

    this.host = new HostAgent({ settings, log: this.log });
    this.subAgents = new SubAgentsPool({ settings, log: this.log });
    this.fallback = new FallbackAgent({ settings, log: this.log });

    this._down = {}; // agentId -> { until, reason }
  }

  isDown(id) {
    const d = this._down[id];
    return !!(d && d.until > Date.now());
  }

  markDown(id, reason, ms = 120000) {
    this._down[id] = { since: Date.now(), until: Date.now() + ms, reason: String(reason || 'failed').slice(0, 160) };
    this.log.write('agent.down', { agent: id, reason: this._down[id].reason });
  }

  markUp(id) {
    if (this._down[id]) this.log.write('agent.up', { agent: id });
    delete this._down[id];
  }

  async health() {
    const [h, s, f] = await Promise.all([
      this.host.health(),
      this.subAgents.health(),
      this.fallback.health(),
    ]);
    const ollama = this.ollama ? {
      id: 'local',
      label: 'Local',
      model: this.ollama.model(),
      provider: 'ollama',
      url: this.ollama.url(),
      reachable: await this.ollama.ping().catch(() => false),
      status: 'ok',
    } : null;

    return {
      map: AGENT_MAP,
      agents: {
        host: { ...h, down: this._down['host'] || null, usable: h.configured && !this.isDown('host') && !!this.net.online },
        subAgents: { ...s, down: this._down['sub-agents'] || null, usable: s.configured && !this.isDown('sub-agents') && !!this.net.online },
        fallback: { ...f, down: this._down['fallback'] || null, usable: f.configured && !this.isDown('fallback') && !!this.net.online },
        local: ollama,
      },
      routing: AGENT_MAP.routing,
      ladder: modelLadder(),
    };
  }

  // Select the best available agent in priority order (for status/UI)
  // For actual chat, we try all regardless of down to allow self-heal
  async selectAgent() {
    const health = await this.health();
    const order = ['host', 'subAgents', 'fallback'];
    for (const id of order) {
      const a = health.agents[id];
      if (a && a.usable) return { id, agent: this[id === 'subAgents' ? 'subAgents' : id], health: a };
    }
    // total cloud outage → local
    if (health.agents.local && health.agents.local.reachable) {
      return { id: 'local', agent: this.ollama, health: health.agents.local };
    }
    // Even if all marked down, return host if configured and online to allow self-heal probe
    // This is crucial for B2 self-heal test: after outage, we must still try cloud
    if (this.net.online) {
      if (this.host.isConfigured()) return { id: 'host', agent: this.host, health: health.agents.host };
      if (this.subAgents.isConfigured()) return { id: 'subAgents', agent: this.subAgents, health: health.agents.subAgents };
      if (this.fallback.isConfigured()) return { id: 'fallback', agent: this.fallback, health: health.agents.fallback };
    }
    return null;
  }

  // Main chat entry used by orchestrator: tries host → sub-agents → fallback → local
  // Tries even if marked down to allow self-heal (B2 test)
  async chat({ messages, tools, max_tokens, text, uid }) {
    // 1. Host (gpt-oss-120b) — try even if down to allow self-heal
    if (this.host.isConfigured() && this.net.online) {
      try {
        const res = await this.host.chat({ messages, tools, max_tokens });
        this.markUp('host');
        return { ...res, agent: 'host', model: this.host.model };
      } catch (e) {
        this.markDown('host', e.message);
        // try next
      }
    }

    // 2. Sub-agents (Qwen 5-account pool)
    if (this.subAgents.isConfigured() && this.net.online) {
      try {
        const res = await this.subAgents.chat({ messages, tools, prompt: text });
        if (res && res.ok !== false) {
          this.markUp('sub-agents');
          return { message: res.message, raw: res.raw, agent: 'sub-agents', model: this.subAgents.model, worker: res.worker };
        }
      } catch (e) {
        this.markDown('sub-agents', e.message);
      }
    }

    // 3. Fallback (Gemini 3-key overflow)
    if (this.fallback.isConfigured() && this.net.online) {
      try {
        const res = await this.fallback.chat({ messages, max_tokens });
        this.markUp('fallback');
        return { ...res, agent: 'fallback', model: this.fallback.model };
      } catch (e) {
        this.markDown('fallback', e.message);
      }
    }

    // 4. Local (Ollama)
    if (this.ollama) {
      try {
        if (!(await this.ollama.ping())) throw new Error('Ollama unreachable');
        const mappedTools = tools ? tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.input_schema },
        })) : [];
        const msg = await this.ollama.chat(messages, mappedTools);
        return { message: msg, agent: 'local', model: this.ollama.model() };
      } catch (e) {
        throw e;
      }
    }

    throw new Error('All agents down — no brain available');
  }

  // Parallel sub-agent fan-out for complex tasks
  async fanOut(subTasks) {
    if (!this.subAgents.isConfigured()) throw new Error('Sub-agents not configured');
    return this.subAgents.runParallel(subTasks);
  }
}

module.exports = { MultiAgentSystem, AGENT_MAP, listAgents, modelLadder };
