"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const request = require("supertest");
const { setupTestServer, cleanupTestServer } = require("./_helpers");

// Notas subidas ANTES de esta feature no tienen tipo/justificacion/notaOrigenId/
// entregaDiferida/deletedAt/deletedBy en notas.json — deben seguir contando
// como "pedido" normal en /api/kpis y /api/notas, sin desaparecer del dashboard.
test("una nota preexistente sin campo 'tipo' cuenta como pedido en /api/kpis", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "" });
  try {
    const dbFile = path.join(process.env.DATA_DIR, "notas.json");
    const notaLegacy = {
      id: "legacy-1",
      batchKey: "b1",
      originalName: "vieja.pdf",
      filename: "vieja.pdf",
      cliente: "Clienta Vieja",
      total: 1000,
      pagado: 1000,
      deliveredAt: new Date().toISOString(),
      dueAt: new Date().toISOString(),
      firstPaymentAt: new Date().toISOString(),
      uploadedAt: new Date().toISOString(),
      // sin tipo, justificacion, notaOrigenId, entregaDiferida, deletedAt, deletedBy
    };
    fs.writeFileSync(dbFile, JSON.stringify([notaLegacy], null, 2));

    const kpis = (await request(app).get("/api/kpis")).body;
    assert.strictEqual(kpis.totalCobrable, 1000, "la nota legacy debe contar como cobrable");
    assert.strictEqual(kpis.totalCobrado, 1000, "la nota legacy debe contar como cobrada");

    const notas = (await request(app).get("/api/notas")).body.notas;
    assert.strictEqual(notas.length, 1, "la nota legacy debe seguir apareciendo en el tablero");
    assert.strictEqual(notas[0].tipo, "pedido", "debe normalizarse a tipo=pedido por default");
  } finally {
    cleanupTestServer(tmpDir);
  }
});
