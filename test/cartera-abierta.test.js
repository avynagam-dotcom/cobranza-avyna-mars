"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const request = require("supertest");
const { setupTestServer, cleanupTestServer } = require("./_helpers");

// El % Cobranza histórico (totalCobrado/totalCobrable sobre TODAS las notas
// entregadas, incluidas las liquidadas hace meses) se queda pegado arriba de
// 90% siempre, porque las notas ya pagadas se acumulan y diluyen cualquier
// problema nuevo. Netie 2026-07-17: necesita un pulso vivo — cómo va la
// cobranza SOLO de las notas que todavía tienen saldo pendiente (no liquidadas).
// Esa cartera abierta se encoge sola conforme se liquida una nota, así que el
// número siempre refleja el presente, no el arrastre histórico.
test("GET /api/kpis excluye notas ya liquidadas (saldo=0) de la cartera abierta", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "" });
  try {
    const dbFile = path.join(process.env.DATA_DIR, "notas.json");
    const notas = [
      {
        id: "liquidada-1",
        cliente: "Clienta Pagada",
        total: 1000,
        pagado: 1000, // saldo 0, ya liquidada — NO debe contar en cartera abierta
        tipo: "pedido",
        deliveredAt: new Date().toISOString(),
      },
      {
        id: "abierta-1",
        cliente: "Clienta Parcial",
        total: 2000,
        pagado: 500, // saldo 1500, sigue abierta
        tipo: "pedido",
        deliveredAt: new Date().toISOString(),
      },
    ];
    fs.writeFileSync(dbFile, JSON.stringify(notas, null, 2));

    const kpis = (await request(app).get("/api/kpis")).body;

    // histórico sigue sumando TODO (no se toca, Netie confirmó que está bien)
    assert.strictEqual(kpis.totalCobrable, 3000);
    assert.strictEqual(kpis.totalCobrado, 1500);

    // cartera abierta: solo la nota con saldo > 0
    assert.strictEqual(kpis.totalCobrableAbierto, 2000, "solo la nota abierta cuenta su total");
    assert.strictEqual(kpis.totalCobradoAbierto, 500, "solo lo pagado de la nota abierta");
    assert.strictEqual(kpis.totalSaldoAbierto, 1500);
    assert.strictEqual(kpis.notasAbiertasCount, 1, "la nota liquidada no debe contarse");
    assert.strictEqual(kpis.pctCobranzaAbierta, 0.25, "500/2000 — el pulso vivo, no el 75% histórico (1500/3000)");
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("GET /api/kpis: si no hay ninguna nota abierta, pctCobranzaAbierta es 1 (nada pendiente, no 0/0)", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "" });
  try {
    const dbFile = path.join(process.env.DATA_DIR, "notas.json");
    const notas = [
      {
        id: "liquidada-1",
        cliente: "Clienta Pagada",
        total: 1000,
        pagado: 1000,
        tipo: "pedido",
        deliveredAt: new Date().toISOString(),
      },
    ];
    fs.writeFileSync(dbFile, JSON.stringify(notas, null, 2));

    const kpis = (await request(app).get("/api/kpis")).body;
    assert.strictEqual(kpis.notasAbiertasCount, 0);
    assert.strictEqual(kpis.totalCobrableAbierto, 0);
    assert.strictEqual(kpis.pctCobranzaAbierta, 1);
  } finally {
    cleanupTestServer(tmpDir);
  }
});
