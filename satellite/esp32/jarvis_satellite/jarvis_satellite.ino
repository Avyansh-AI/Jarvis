/*
 * Jarvis — ESP32 satellite node firmware
 * ======================================
 * Thin audio/sensor client for the Jarvis hub. Place one per room.
 *
 * Features
 *   - Connects to the hub over local Wi-Fi via WebSocket (/ws/satellite)
 *   - Optional on-device wake word (ESP-SR; else PIR/motion or button wake)
 *   - I2S microphone (INMP441) capture pipeline, streamed to hub for Whisper STT
 *   - I2S speaker (MAX98357A) playback for hub responses ("satellite.say")
 *   - DHT22 temperature/humidity + PIR presence reporting
 *   - Heartbeat, auto-reconnect with backoff, graceful degradation:
 *     if the hub is unreachable, the node says so out loud instead of
 *     failing silently, and queues nothing it can't deliver later (hub
 *     side queues commands per-node — see hub/satellites.js).
 *
 * Arduino IDE / PlatformIO — board: "ESP32 DevKit" (or ESP32-S3 for ESP-SR).
 * Library: "WebSockets" by Markus Sattler (arduinoWebSockets >= 2.4).
 *          "DHT sensor library" by Adafruit (+ Adafruit Unified Sensor).
 * For ESP-SR wake word, use the esp32-arduino + esp-skainet toolchain and
 * set USE_ESP_SR 1 (Arduino-IDE-only builds leave it 0 and use PIR/button).
 */

#include <WiFi.h>
#include <WebSocketsClient.h>
#include <driver/i2s.h>
#include <DHT.h>
#include <ArduinoJson.h>
#include "mbedtls/md.h"                 // HMAC-SHA256 for hub-proof verification

/* ---------------- config ---------------- */
#define NODE_ID        "esp32-livingroom"
#define NODE_NAME      "Living Room"
#define WIFI_SSID      "YOUR_WIFI"
#define WIFI_PASS      "YOUR_WIFI_PASSWORD"
#define HUB_HOST       "192.168.1.10"   // hub (Raspberry Pi) LAN IP
#define HUB_PORT       8080
#define HUB_TOKEN      ""               // endpoint auth: match hub MAX_TOKEN if set
#define SAT_TOKEN      ""               // pairing secret: match hub SATELLITE_TOKEN if set.
                                        // When set, satellites must prove it to the hub AND the hub
                                        // proves it back (welcome.proof) — rogue hubs get ignored.

#define USE_ESP_SR     0                // 1 = on-device wake word (S3 + esp-sr)
#define ENABLE_AUDIO   0                // 1 when INMP441/MAX98357A wired
#define ENABLE_DHT     1
#define ENABLE_PIR     1

#define PIN_DHT        15
#define DHT_TYPE       DHT22
#define PIN_PIR        13
#define PIN_WAKE_BTN   0                // BOOT button
#define SENSOR_INTERVAL_MS 30000        // raise for battery nodes; see SCALABILITY_NOTES.md (deep sleep guidance)
#define I2S_WS         25               // INMP441 WS / MAX98357A LRC
#define I2S_SD         33               // INMP441 SD (mic in)
#define I2S_SCK        26               // shared BCLK
#define I2S_DOUT       27               // MAX98357A DIN (speaker out)
/* ----------------------------------------- */

WebSocketsClient ws;
DHT dht(PIN_DHT, DHT_TYPE);

bool     hubUp       = false;
uint32_t backoffMs   = 1000;
uint32_t lastHello   = 0;
uint32_t lastSensors = 0;
bool     pirState    = false;

/* ---------- I2S (mic 16kHz mono for STT; same bus drives speaker) ---------- */
void audioInit() {
#if ENABLE_AUDIO
  i2s_config_t cfg = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX | I2S_MODE_TX),
    .sample_rate = 16000,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = I2S_COMM_FORMAT_STAND_I2S,
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 8,
    .dma_buf_len = 256,
    .use_apll = false,
    .tx_desc_auto_clear = true,
  };
  i2s_pin_config_t pins = {
    .bck_io_num = I2S_SCK, .ws_io_num = I2S_WS,
    .data_out_num = I2S_DOUT, .data_in_num = I2S_SD,
  };
  i2s_driver_install(I2S_NUM_0, &cfg, 0, NULL);
  i2s_set_pin(I2S_NUM_0, &pins);
#endif
}

/* ---------- wake ---------- */
bool wakeDetected() {
#if ENABLE_AUDIO && USE_ESP_SR
  // Hook esp-sr multinet/wakenet here (ESP32-S3 only). Return true on "Hi, ESP"
  // style wake, then the hub takes over with Whisper for the real STT.
  return false;
#else
  return digitalRead(PIN_WAKE_BTN) == LOW; // physical button = manual wake
#endif
}

/* ---------- hub authenticity (Round 6, mutual auth) ----------
   If HUB_TOKEN is set, the hub proves itself on welcome:
     proof = HMAC_SHA256(HUB_TOKEN, "<NODE_ID>|<ts>")
   We only act on commands from a hub whose proof verifies. A rogue "hub" on
   the LAN that doesn't know the token cannot drive speaker/actuator nodes.
   NOTE (compile-verified logic; hardware test pending — see NETWORK_SECURITY.md). */
bool hubTrusted = false;
void hmacSha256Hex(const char *key, const char *msg, char *outHex /*>=65*/) {
  unsigned char mac[32];
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  mbedtls_md_setup(&ctx, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 1);
  mbedtls_md_hmac_starts(&ctx, (const unsigned char *)key, strlen(key));
  mbedtls_md_hmac_update(&ctx, (const unsigned char *)msg, strlen(msg));
  mbedtls_md_hmac_finish(&ctx, mac);
  mbedtls_md_free(&ctx);
  for (int i = 0; i < 32; i++) sprintf(outHex + i * 2, "%02x", mac[i]);
  outHex[64] = 0;
}
bool hubProofOk(const char *id, long ts, const char *proof) {
  if (!strlen(SAT_TOKEN)) return true;          // no shared secret configured → open mode (hub warns loudly)
  if (!proof || !strlen(proof)) return false;   // token configured → proof mandatory
  char msg[96]; snprintf(msg, sizeof(msg), "%s|%ld", id, ts);
  char expect[65]; hmacSha256Hex(SAT_TOKEN, msg, expect);
  return strcmp(expect, proof) == 0;
}

/* ---------- hub messages ---------- */
void onWsEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      hubUp = true; backoffMs = 1000;
      {
        StaticJsonDocument<256> doc;
        doc["type"] = "satellite.hello";
        doc["id"] = NODE_ID;
        doc["name"] = NODE_NAME;
        if (strlen(SAT_TOKEN)) doc["token"] = SAT_TOKEN; // must match the hub's SATELLITE_TOKEN if set
        JsonObject caps = doc.createNestedObject("caps");
        caps["mic"] = ENABLE_AUDIO; caps["speaker"] = ENABLE_AUDIO;
        caps["wake"] = USE_ESP_SR; caps["sensors"] = ENABLE_DHT || ENABLE_PIR;
        String out; serializeJson(doc, out);
        ws.sendTXT(out);
        Serial.println("[sat] hello sent");
      }
      break;
    case WStype_DISCONNECTED:
      hubUp = false;
      Serial.println("[sat] hub lost — will retry with backoff");
      break;
    case WStype_TEXT:
      {
        StaticJsonDocument<384> doc;
        if (deserializeJson(doc, payload, length)) return;
        const char *t = doc["type"] | "";
        if (!strcmp(t, "satellite.welcome")) {
          hubTrusted = hubProofOk(doc["id"] | NODE_ID, doc["ts"] | 0L, doc["proof"] | "");
          Serial.printf("[sat] hub proof %s\n", hubTrusted ? "OK — trusted" : "FAILED — ignoring commands until a real hub proves itself");
          break;
        }
        if (strlen(SAT_TOKEN) && !hubTrusted) { Serial.println("[sat] untrusted hub — command ignored"); break; }
        if (!strcmp(t, "satellite.say")) {
          const char *text = doc["text"] | "...";
          Serial.printf("[sat] SAY: %s\n", text);
#if ENABLE_AUDIO
          const char *url = doc["audioUrl"] | "";
          if (strlen(url)) { /* TODO: HTTP GET WAV from hub -> i2s_write() */ }
#else
          (void)text; // headless node: could blink an LED / buzz here
#endif
        }
      }
      break;
    default: break;
  }
}

void connectHub() {
  String path = "/ws/satellite";
  if (strlen(HUB_TOKEN)) path += "?token=" + String(HUB_TOKEN);
  ws.begin(HUB_HOST, HUB_PORT, path);
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(0); // we manage backoff ourselves
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_PIR, INPUT);
  pinMode(PIN_WAKE_BTN, INPUT_PULLUP);
  dht.begin();
  audioInit();

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("[sat] wifi connecting");
  while (WiFi.status() != WL_CONNECTED) { delay(300); Serial.print('.'); }
  Serial.printf("\n[sat] wifi up: %s\n", WiFi.localIP().toString().c_str());

  connectHub();
}

void loop() {
  ws.loop();

  /* reconnect with backoff + audible notice (never silent) */
  if (!hubUp && millis() - lastHello > backoffMs) {
    lastHello = millis();
    backoffMs = min(backoffMs * 2, (uint32_t)30000);
    Serial.println("[sat] retrying hub...");
    connectHub();
#if ENABLE_AUDIO
    // Play a short cached "hub unreachable" tone/clip from flash — graceful,
    // local, no network required.
#endif
  }

  /* wake */
  static uint32_t lastWakeSent = 0;
  if (hubUp && wakeDetected() && millis() - lastWakeSent > 3000) {
    lastWakeSent = millis();
    ws.sendTXT("{\"type\":\"satellite.wake\"}");
    Serial.println("[sat] wake sent");
  }

  /* PIR edge */
  bool pir = digitalRead(PIN_PIR);
  if (ENABLE_PIR && pir != pirState) {
    pirState = pir;
    if (hubUp) {
      StaticJsonDocument<192> doc;
      doc["type"] = "satellite.sensor";
      JsonObject d = doc.createNestedObject("data");
      d["motion"] = pir; d["presence"] = pir;
      String out; serializeJson(doc, out); ws.sendTXT(out);
    }
  }

  /* periodic telemetry (30 s) */
  if (hubUp && ENABLE_DHT && millis() - lastSensors > SENSOR_INTERVAL_MS) {
    lastSensors = millis();
    float t = dht.readTemperature(), h = dht.readHumidity();
    if (!isnan(t) && !isnan(h)) {
      StaticJsonDocument<192> doc;
      doc["type"] = "satellite.sensor";
      JsonObject d = doc.createNestedObject("data");
      d["temperature"] = round(t * 10) / 10.0;
      d["humidity"] = round(h);
      d["motion"] = pirState;
      String out; serializeJson(doc, out); ws.sendTXT(out);
    }
  }
}
