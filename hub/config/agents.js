'use strict';
/**
 * Jarvis Multi-Agent Map — canonical definition of the architecture shown in the diagram.
 *
 *   Jarvis (Multi-agent assistant)
 *     ├─ Host      → gpt-oss-120b  (OpenRouter)
 *     ├─ Sub-agents → Qwen3.6-27b (5 accounts)
 *     ├─ TTS       → Orpheus      (Groq TTS)
 *     └─ Fallback  → Gemini       (3-key overflow)
 *
 * This file is the single source of truth for model ids, env var names, and
 * routing priorities. Everything else (ModelRouter, orchestrator, server status,
 * web UI) reads from here so the diagram and the code never drift.
 */

const AGENT_MAP = {
  name: 'Jarvis',
  label: 'Multi-agent assistant',
  version: '2.0.0',
  agents: {
    host: {
      id: 'host',
      label: 'Host',
      model: process.env.HOST_MODEL || process.env.OPENROUTER_MODEL || 'openai/gpt-oss-120b',
      provider: 'openrouter',
      description: 'Primary brain — gpt-oss-120b via OpenRouter, 3-key rotation',
      keys: ['OPENROUTER_KEY_1', 'OPENROUTER_KEY_2', 'OPENROUTER_KEY_3'],
      priority: 1,
    },
    subAgents: {
      id: 'sub-agents',
      label: 'Sub-agents',
      model: process.env.QWEN_MODEL || 'qwen/qwen3-27b',
      // alt ids that have been seen in the wild for the same family
      altModels: ['qwen/qwen2.5-27b-instruct', 'qwen/qwen3-30b-a3b', 'qwen/qwen3.5-27b'],
      provider: 'openrouter',
      description: 'Parallel workers — Qwen3.6-27b with 5 accounts',
      keys: ['QWEN_KEY_1', 'QWEN_KEY_2', 'QWEN_KEY_3', 'QWEN_KEY_4', 'QWEN_KEY_5'],
      // fallback to OPENROUTER keys if dedicated QWEN keys not set
      fallbackKeys: ['OPENROUTER_KEY_1', 'OPENROUTER_KEY_2', 'OPENROUTER_KEY_3'],
      count: 5,
      priority: 2,
    },
    tts: {
      id: 'tts',
      label: 'TTS',
      model: process.env.TTS_MODEL || process.env.GROQ_TTS_MODEL || 'orpheus',
      provider: 'groq',
      description: 'Voice — Orpheus via Groq TTS',
      keys: ['GROQ_API_KEY'],
      priority: 3,
    },
    fallback: {
      id: 'fallback',
      label: 'Fallback',
      model: process.env.FALLBACK_MODEL || process.env.GEMINI_MODEL || 'google/gemini-2.0-flash-001',
      altModels: ['google/gemini-2.5-pro', 'google/gemini-2.5-flash', 'google/gemini-pro'],
      provider: 'openrouter', // Gemini via OpenRouter (same 3-key overflow)
      // dedicated Gemini keys, but can overflow to OpenRouter keys
      keys: ['GEMINI_KEY_1', 'GEMINI_KEY_2', 'GEMINI_KEY_3'],
      fallbackKeys: ['OPENROUTER_KEY_1', 'OPENROUTER_KEY_2', 'OPENROUTER_KEY_3'],
      description: 'Safety net — Gemini with 3-key overflow',
      priority: 4,
    },
  },
  // Routing order: host → sub-agents (parallel) → fallback → local
  routing: ['host', 'subAgents', 'fallback', 'local'],
};

function getAgent(id) {
  return AGENT_MAP.agents[id] || null;
}

function listAgents() {
  return Object.values(AGENT_MAP.agents).sort((a, b) => a.priority - b.priority);
}

function modelLadder() {
  // Build a MODEL_PRIORITY compatible ladder from the map
  // Includes Groq and Gemini rungs as requested — all via OpenRouter except local floor
  const host = AGENT_MAP.agents.host.model;
  const sub = AGENT_MAP.agents.subAgents.model;
  const groqModel = process.env.GROQ_MODEL || 'groq/llama-3.3-70b-versatile';
  const fb = AGENT_MAP.agents.fallback.model; // Gemini via OpenRouter
  const ollamaModel = process.env.OLLAMA_MODEL || 'hf.co/huihui-ai/Huihui-Qwythos-9B-Claude-Mythos-5-1M-abliterated-GGUF:Q4_K_M';
  return [
    host,
    sub,
    groqModel,
    fb,
    `ollama:${ollamaModel}`,
  ];
}

module.exports = { AGENT_MAP, getAgent, listAgents, modelLadder };
