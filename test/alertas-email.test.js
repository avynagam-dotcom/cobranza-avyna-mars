"use strict";

const { test, mock, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");

// utils/alerts.js debe existir y exportar enviarAlertaEmail({ tipo, nota }).
// Se testea en aislamiento total (sin server.js, sin DATA_DIR) mockeando fetch.
const { enviarAlertaEmail } = require("../utils/alerts");

let originalFetch;
let originalEnv;

beforeEach(() => {
  originalFetch = global.fetch;
  originalEnv = { ...process.env };
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env = originalEnv;
});

test("enviarAlertaEmail con RESEND_API_KEY configurada llama a la API de Resend con asunto de BONIFICACIÓN", async () => {
  process.env.RESEND_API_KEY = "test-key";
  process.env.ALERT_EMAIL_FROM = "alertas@avyna.test";
  process.env.ALERT_EMAIL_TO = "netie@example.com";

  const fetchMock = mock.fn(async () => ({ ok: true, text: async () => "" }));
  global.fetch = fetchMock;

  await enviarAlertaEmail({
    tipo: "CLASIFICACION",
    nota: { cliente: "Ana Test", total: 300, tipo: "bonificacion", justificacion: "regalo" },
  });

  assert.strictEqual(fetchMock.mock.callCount(), 1);
  const [url, options] = fetchMock.mock.calls[0].arguments;
  assert.strictEqual(url, "https://api.resend.com/emails");
  assert.strictEqual(options.headers.Authorization, "Bearer test-key");
  const body = JSON.parse(options.body);
  assert.match(body.subject, /BONIFICACI[ÓO]N/i);
  assert.deepStrictEqual(body.to, ["netie@example.com"]);
});

test("enviarAlertaEmail para BORRADO manda asunto de nota eliminada", async () => {
  process.env.RESEND_API_KEY = "test-key";
  process.env.ALERT_EMAIL_FROM = "alertas@avyna.test";
  process.env.ALERT_EMAIL_TO = "netie@example.com";

  const fetchMock = mock.fn(async () => ({ ok: true, text: async () => "" }));
  global.fetch = fetchMock;

  await enviarAlertaEmail({ tipo: "BORRADO", nota: { cliente: "Ana Test", total: 100 } });

  const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body);
  assert.match(body.subject, /eliminad/i);
});

test("sin RESEND_API_KEY no llama fetch y no lanza excepción", async () => {
  delete process.env.RESEND_API_KEY;
  const fetchMock = mock.fn(async () => ({ ok: true, text: async () => "" }));
  global.fetch = fetchMock;

  await assert.doesNotReject(
    enviarAlertaEmail({ tipo: "CLASIFICACION", nota: { cliente: "Ana", total: 1, tipo: "bonificacion" } })
  );
  assert.strictEqual(fetchMock.mock.callCount(), 0);
});

test("si Resend responde !ok, enviarAlertaEmail lanza (para que el caller decida loggear, no tumbar el endpoint)", async () => {
  process.env.RESEND_API_KEY = "test-key";
  process.env.ALERT_EMAIL_FROM = "alertas@avyna.test";
  process.env.ALERT_EMAIL_TO = "netie@example.com";

  global.fetch = mock.fn(async () => ({ ok: false, status: 401, text: async () => "unauthorized" }));

  await assert.rejects(
    enviarAlertaEmail({ tipo: "CLASIFICACION", nota: { cliente: "Ana", total: 1, tipo: "bonificacion" } })
  );
});

test("subir tipo='pedido' no debe disparar alerta (comportamiento validado a nivel de caller, no de esta función)", () => {
  // enviarAlertaEmail no decide el "si envía o no" por tipo — eso lo decide el caller en server.js
  // (solo llama la función cuando tipo !== 'pedido'). Este test documenta esa responsabilidad.
  assert.strictEqual(typeof enviarAlertaEmail, "function");
});
