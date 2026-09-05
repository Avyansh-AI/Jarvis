'use strict';
/**
 * Boot-time configuration validation — fail loud, not weird.
 * Returns human-readable warnings (not hard errors: Jarvis is built to degrade
 * gracefully, but you should *hear about* what's degraded).
 */
function validateConfig(data, env = process.env) {
  const warnings = [];
  const { loadKeys } = require('./keyring');
  const hasKeys = loadKeys(env).length > 0; // v1.0.7: .env OPENROUTER_KEY_n is the ONLY key source

  if (!env.MAX_TOKEN) {
    warnings.push('MAX_TOKEN is not set — the hub listens on 0.0.0.0 with NO auth; anyone on this network can talk to it. Set MAX_TOKEN in .env to require a bearer token.');
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone: data.timezone || 'Asia/Kolkata' }); }
  catch { warnings.push(`timezone "${data.timezone}" is not a valid IANA name — falling back silently is a risk; fix Settings → Timezone.`); }

  if (data.privacy.llm === 'cloud' && !hasKeys) {
    warnings.push('Brain is set to cloud but no OpenRouter keys are configured — add OPENROUTER_KEY_1/2/3 to .env (chat falls back to intents/Ollama until then).');
  }
  if (data.homeAssistant?.url && !data.homeAssistant?.token) warnings.push('Home Assistant URL is set but the token is missing — smart-home calls will fail.');
  if (!data.homeAssistant?.url && data.homeAssistant?.token) warnings.push('Home Assistant token is set but the URL is missing.');
  if ((data.emergencyContacts || []).length && !data.emergencyWebhook) warnings.push('Emergency contacts exist but no EMERGENCY_WEBHOOK — SOS will only alert locally.');
  if (data.privacy.vision === 'cloud' && !hasKeys) {
    warnings.push('Vision is set to cloud but there are no OpenRouter keys — camera descriptions will fail (motion sensing still works).');
  }
  if (data.update?.allow) warnings.push('Self-update is ENABLED (ALLOW_SELF_UPDATE=1) — the update endpoint is live. Make sure MAX_TOKEN is set.');
  return warnings;
}

module.exports = { validateConfig };
