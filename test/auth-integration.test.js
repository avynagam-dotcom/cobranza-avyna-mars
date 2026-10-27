"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { setupTestServer } = require("./_helpers");

// El candado de Face ID está conectado en server.js y protege todo el tablero.

test("server.js con login encendido: nada se lee ni se escribe sin sesión", async () => {
  const { app } = setupTestServer({ auth: true });

  const health = await request(app).get("/healthz");
  assert.equal(health.status, 200);

  for (const [method, url] of [
    ["get", "/api/notas"],
    ["get", "/api/kpis"],
    ["get", "/api/notas/eliminadas"],
    ["get", "/api/faltantes"],
    ["post", "/api/pago"],
    ["post", "/api/entregar"],
    ["post", "/api/upload"],
    ["delete", "/api/notas/cualquiera"],
    ["get", "/uploads/x.pdf"],
  ]) {
    const r = await request(app)[method](url);
    assert.equal(r.status, 401, `${method.toUpperCase()} ${url} debía dar 401, dio ${r.status}`);
  }

  const root = await request(app).get("/");
  assert.equal(root.status, 200);
  assert.match(root.text, /código/);
  assert.ok(!root.text.includes("api/notas"), "la pantalla de login no debe traer el tablero");
});
