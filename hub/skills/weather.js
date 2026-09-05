'use strict';
/** Weather — Open-Meteo (no API key needed), spoken-style summaries. */
const { httpRetry: http } = require('../net'); // retry+backoff for integrations

const WMO = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'frosty fog', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'light showers', 81: 'showers', 82: 'heavy showers',
  85: 'snow showers', 86: 'heavy snow showers', 95: 'a thunderstorm',
  96: 'a thunderstorm with hail', 99: 'a severe thunderstorm',
};

async function geocode(city) {
  const res = await http(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en`);
  if (!res.ok) throw new Error('geocoding failed');
  const data = await res.json();
  if (!data.results || !data.results.length) throw new Error(`I couldn't find "${city}"`);
  return data.results[0];
}

async function fetchWeather(city) {
  const place = await geocode(city);
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&forecast_days=2&timezone=auto`;
  const res = await http(url);
  if (!res.ok) throw new Error('weather service hiccupped');
  const data = await res.json();
  return { place, data };
}

function summarize({ place, data }) {
  const c = data.current, d = data.daily;
  const desc = WMO[c.weather_code] || 'changeable skies';
  const rain = d.precipitation_probability_max?.[0] ?? 0;
  const rainBit = rain >= 50 ? ` Rain is likely today (${rain}%).` : rain >= 20 ? ` Small chance of rain (${rain}%).` : '';
  return {
    city: `${place.name}${place.country ? ', ' + place.country : ''}`,
    tempC: Math.round(c.temperature_2m), feelsC: Math.round(c.apparent_temperature),
    humidity: c.relative_humidity_2m, windKph: Math.round(c.wind_speed_10m),
    highC: Math.round(d.temperature_2m_max[0]), lowC: Math.round(d.temperature_2m_min[0]),
    rainPct: rain, desc,
    say: `In ${place.name} it's ${Math.round(c.temperature_2m)} degrees with ${desc}, feeling like ${Math.round(c.apparent_temperature)}. ` +
      `Today's high is ${Math.round(d.temperature_2m_max[0])} and the low ${Math.round(d.temperature_2m_min[0])}.${rainBit}`,
  };
}

module.exports = {
  name: 'weather',
  label: 'Weather',
  description: 'Current conditions and today/tomorrow outlook (Open-Meteo, no key required).',
  async current(city) {
    if (!city) throw new Error('no city set — say "weather in <city>" or set a home city in Settings');
    return summarize(await fetchWeather(city));
  },
  intents: [
    {
      patterns: [/\bweather\b/i, /\b(temperature|rain|raining|sunny|forecast|umbrella)\b/i],
      run: async (m, text, ctx) => {
        const cm = text.match(/\b(?:in|for|at)\s+([a-z][a-z\s'.-]+?)(?:\s+today|\s+tomorrow|\s+now|\?|$)/i);
        const city = (cm && cm[1] && !/^(today|tomorrow|here|there)/i.test(cm[1])) ? cm[1].trim() : ctx.settings.homeCity;
        if (!ctx.net.online) return { say: "I'm offline, so I can't reach the weather service just now." };
        try {
          const out = city ? await module.exports.current(city) : { say: "Which city? You can also set a home city in Settings." };
          if (/tomorrow/i.test(text)) {
            const { place, data } = await fetchWeather(city);
            const d = data.daily;
            return { say: `Tomorrow in ${place.name}: ${WMO[d.weather_code[1]] || 'mixed skies'}, high ${Math.round(d.temperature_2m_max[1])}, low ${Math.round(d.temperature_2m_min[1])}.` };
          }
          return { say: out.say, data: out };
        } catch (e) {
          return { say: `I couldn't get the weather — ${e.message}.`, error: true };
        }
      },
    },
  ],
  tools: [
    {
      name: 'get_weather',
      description: 'Current weather and today outlook for a city (spoken summary).',
      input_schema: { type: 'object', properties: { city: { type: 'string' } } },
      run: async ({ city }, ctx) => {
        if (!ctx.net.online) return { say: "I'm offline — no weather right now." };
        try {
          const out = await module.exports.current(city || ctx.settings.homeCity);
          return { say: out.say, data: out };
        } catch (e) { return { say: `Couldn't get weather: ${e.message}` }; }
      },
    },
  ],
};
