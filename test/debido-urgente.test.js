"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const request = require("supertest");
const { setupTestServer, cleanupTestServer } = require("./_helpers");

// Netie 2026-08-02: cuestiono el 36.4% de "Cartera abierta (pulso vivo)"
// porque mezcla saldo TODAVIA EN PLAZO (dentro de los 14 dias de credito)
// con saldo VENCIDO real -- una clienta que entrego hace 2 dias cuenta
// exactamente igual que una que debe desde hace 2 meses. Metrica nueva:
// monto exacto de lo que YA deberia estar cobrado y no esta, separado por
// antiguedad de la obligacion (<=30d urgente, >30d vieja/gota a gota).
// Puerto 1:1 de calcula_debido_urgente en engine.py (money-coach).
test("GET /api/kpis expone montoDebidoUrgente y montoCarteraVieja, distinto de pctCobranzaAbierta", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "" });
  try {
    const dbFile = path.join(process.env.DATA_DIR, "notas.json");
    const ahora = new Date();
    const diasAtras = (d) => new Date(ahora.getTime() - d * 24 * 60 * 60 * 1000).toISOString();
    const diasAdelante = (d) => new Date(ahora.getTime() + d * 24 * 60 * 60 * 1000).toISOString();

    const notas = [
      // Entregada hace 5d, CERO pagado -> ni el primer 50% se cobro.
      // dueAt en el futuro (9d mas) -> obligado=0.5*1000=500, antiguedad
      // desde deliveredAt (5d) -> urgente.
      {
        id: "falla-primer-50",
        cliente: "Falla primer 50%",
        total: 1000,
        pagado: 0,
        tipo: "pedido",
        deliveredAt: diasAtras(5),
        dueAt: diasAdelante(9),
      },
      // Entregada hace 40d, dueAt vencido hace 26d, saldo completo sin
      // pagar -> obligado=total=2000, antiguedad=26d -> urgente.
      {
        id: "vencido-reciente",
        cliente: "Vencido reciente",
        total: 2000,
        pagado: 0,
        tipo: "pedido",
        deliveredAt: diasAtras(40),
        dueAt: diasAtras(26),
      },
      // Entregada hace 90d, dueAt vencido hace 76d -> obligado=total=1500,
      // antiguedad=76d -> viejo/gota a gota.
      {
        id: "vencido-viejo",
        cliente: "Vencido viejo (meses)",
        total: 1500,
        pagado: 0,
        tipo: "pedido",
        deliveredAt: diasAtras(90),
        dueAt: diasAtras(76),
      },
      // Al corriente: ya pago el 50% inicial, segundo tramo sigue en plazo.
      {
        id: "al-corriente",
        cliente: "Al corriente",
        total: 1000,
        pagado: 500,
        tipo: "pedido",
        deliveredAt: diasAtras(3),
        dueAt: diasAdelante(11),
      },
      // Liquidada -> saldo 0, no cuenta.
      {
        id: "liquidada",
        cliente: "Liquidada",
        total: 800,
        pagado: 800,
        tipo: "pedido",
        deliveredAt: diasAtras(20),
        dueAt: diasAtras(6),
      },
    ];
    fs.writeFileSync(dbFile, JSON.stringify(notas, null, 2));

    const kpis = (await request(app).get("/api/kpis")).body;

    assert.ok(Math.abs(kpis.montoDebidoUrgente - 2500) < 0.01,
      `urgente debe ser $500 (falla primer 50%) + $2000 (vencido reciente) = $2500, salio ${kpis.montoDebidoUrgente}`);
    assert.ok(Math.abs(kpis.montoCarteraVieja - 1500) < 0.01,
      `vieja/gota a gota debe ser solo los $1500 del caso >30d, salio ${kpis.montoCarteraVieja}`);

    // El KPI viejo (pctCobranzaAbierta) sigue vivo sin cambios -- no se toca,
    // solo se agregan los nuevos campos aparte.
    assert.ok("pctCobranzaAbierta" in kpis, "pctCobranzaAbierta no se elimino");
  } finally {
    cleanupTestServer(tmpDir);
  }
});
