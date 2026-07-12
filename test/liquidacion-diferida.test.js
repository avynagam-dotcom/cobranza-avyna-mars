"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const request = require("supertest");
const { setupTestServer, cleanupTestServer } = require("./_helpers");

function pdfBuffer() {
  return Buffer.from("%PDF-1.4 fake buffer, contenido real viene del mock de pdf-parse");
}

async function crearNota(app, overrides = {}) {
  let req = request(app).post("/api/upload");
  for (const [k, v] of Object.entries(overrides)) req = req.field(k, v);
  const res = await req.attach("pdf", pdfBuffer(), `${Math.random()}.pdf`);
  return res.body.nota;
}

test("POST /api/entregar permite marcar bonificación/reposición como entregada manualmente (decisión Netie 2026-07-12: necesita saber si el regalo se entregó físicamente, no depender solo de la liberación automática)", async () => {
  const { app, tmpDir, setPdfText } = setupTestServer({ pdfText: "CLIENTE: Ana Test\nTOTAL: 1000.00" });
  try {
    const pedido = await crearNota(app);
    setPdfText("CLIENTE: Ana Test\nTOTAL: 200.00");
    const bonif = await crearNota(app, {
      tipo: "bonificacion",
      justificacion: "regalo",
      notaOrigenId: pedido.id,
    });

    const res = await request(app).post("/api/entregar").send({ id: bonif.id });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.nota.deliveredAt, "debe quedar marcada como entregada");
    assert.strictEqual(res.body.nota.dueAt, null, "una bonificación entregada no tiene ventana de cobranza");
    assert.strictEqual(res.body.nota.statusCredito, "LIQUIDADO");
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("liquidar el pedido de origen al 100% libera automáticamente su bonificación asociada", async () => {
  const { app, tmpDir, setPdfText } = setupTestServer({ pdfText: "CLIENTE: Ana Test\nTOTAL: 1000.00" });
  try {
    const pedido = await crearNota(app);
    setPdfText("CLIENTE: Ana Test\nTOTAL: 200.00");
    const bonif = await crearNota(app, {
      tipo: "bonificacion",
      justificacion: "regalo",
      notaOrigenId: pedido.id,
    });

    // Antes de liquidar: la bonificación está PENDIENTE_LIQUIDACION_ORIGEN
    let listado = (await request(app).get("/api/notas")).body.notas;
    let b = listado.find((n) => n.id === bonif.id);
    assert.strictEqual(b.statusCredito, "PENDIENTE_LIQUIDACION_ORIGEN");
    assert.strictEqual(b.deliveredAt, null);

    // Pago parcial (500 de 1000) NO debe liberar la bonificación
    await request(app).post("/api/pago").send({ id: pedido.id, monto: 500, metodo: "EFECTIVO" });
    listado = (await request(app).get("/api/notas")).body.notas;
    b = listado.find((n) => n.id === bonif.id);
    assert.strictEqual(b.deliveredAt, null, "no debe liberarse con pago parcial");

    // Pago que completa el saldo (500 restantes) SÍ debe liberar la bonificación
    await request(app).post("/api/pago").send({ id: pedido.id, monto: 500, metodo: "EFECTIVO" });
    listado = (await request(app).get("/api/notas")).body.notas;
    b = listado.find((n) => n.id === bonif.id);
    assert.ok(b.deliveredAt, "debe liberarse automáticamente al saldar el pedido de origen");
    assert.notStrictEqual(b.statusCredito, "PENDIENTE_LIQUIDACION_ORIGEN");
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("bonificación/reposición liberada nunca muestra estado de cobranza real (VENCIDO/POR_VENCER/EN_PLAZO) — no hay nada que cobrar en un regalo", async () => {
  const { app, tmpDir, setPdfText } = setupTestServer({ pdfText: "CLIENTE: Ana Test\nTOTAL: 1000.00" });
  try {
    const pedido = await crearNota(app);
    setPdfText("CLIENTE: Ana Test\nTOTAL: 200.00");
    const bonif = await crearNota(app, {
      tipo: "bonificacion",
      justificacion: "regalo",
      notaOrigenId: pedido.id,
    });

    await request(app).post("/api/pago").send({ id: pedido.id, monto: 1000, metodo: "EFECTIVO" });

    const listado = (await request(app).get("/api/notas")).body.notas;
    const b = listado.find((n) => n.id === bonif.id);
    assert.ok(b.deliveredAt, "debe estar liberada");
    assert.strictEqual(b.statusCredito, "LIQUIDADO", "una bonificación entregada nunca es deuda real — no debe verse como EN_PLAZO/VENCIDO");
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("POST /api/notas/:id/vincular-origen vincula una bonificación sin notaOrigenId y la libera si el origen ya está liquidado", async () => {
  const { app, tmpDir, setPdfText } = setupTestServer({ pdfText: "CLIENTE: Ana Test\nTOTAL: 1000.00" });
  try {
    const pedido = await crearNota(app);
    await request(app).post("/api/pago").send({ id: pedido.id, monto: 1000, metodo: "EFECTIVO" });

    setPdfText("CLIENTE: Ana Test\nTOTAL: 150.00");
    const bonif = await crearNota(app, { tipo: "bonificacion", justificacion: "regalo tardío, sin id a la mano" });
    assert.strictEqual(bonif.notaOrigenId, null);

    const res = await request(app)
      .post(`/api/notas/${bonif.id}/vincular-origen`)
      .send({ notaOrigenId: pedido.id });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.nota.notaOrigenId, pedido.id);
    assert.ok(res.body.nota.deliveredAt, "debe liberarse de inmediato porque el origen ya estaba en saldo 0");
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("GET /api/kpis excluye bonificaciones/reposiciones de totalCobrable/totalCobrado", async () => {
  const { app, tmpDir, setPdfText } = setupTestServer({ pdfText: "CLIENTE: Ana Test\nTOTAL: 1000.00" });
  try {
    const pedido = await crearNota(app);
    await request(app).post("/api/entregar").send({ id: pedido.id });
    await request(app).post("/api/pago").send({ id: pedido.id, monto: 1000, metodo: "EFECTIVO" });

    setPdfText("CLIENTE: Ana Test\nTOTAL: 200.00");
    await crearNota(app, { tipo: "bonificacion", justificacion: "regalo", notaOrigenId: pedido.id });

    const kpis = (await request(app).get("/api/kpis")).body;
    assert.strictEqual(kpis.totalCobrable, 1000);
    assert.strictEqual(kpis.totalCobrado, 1000);
    assert.strictEqual(kpis.gastoBonificaciones, 140, "200 * 0.7 (costo real a Avyna, no el valor impreso en la nota)");
    assert.strictEqual(kpis.gastoReposiciones, 0);
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("GET /api/kpis cuenta el gasto de bonificación desde que se captura, sin esperar a que se libere el pedido de origen (decisión Netie 2026-07-12: el gasto ya ocurrió al regalar el producto)", async () => {
  const { app, tmpDir, setPdfText } = setupTestServer({ pdfText: "CLIENTE: Ana Test\nTOTAL: 1000.00" });
  try {
    const pedido = await crearNota(app);
    setPdfText("CLIENTE: Ana Test\nTOTAL: 200.00");
    await crearNota(app, { tipo: "bonificacion", justificacion: "regalo", notaOrigenId: pedido.id });

    const kpis = (await request(app).get("/api/kpis")).body;
    assert.strictEqual(kpis.gastoBonificaciones, 140, "el gasto se materializa al regalar el producto, no al liberar el pedido de origen; 200 * 0.7");
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("GET /api/kpis aplica BONIF_COST_FACTOR_PCT al costo real de una bonificación (no el valor impreso en la nota) y es configurable por env var — decisión Netie 2026-07-12: a Avyna le cuesta 60-70% del total de la nota, no el 100%; reposiciones sí cuentan al 100% (reponen producto ya vendido, no un regalo con descuento de proveedor)", async () => {
  const prevFactor = process.env.BONIF_COST_FACTOR_PCT;
  process.env.BONIF_COST_FACTOR_PCT = "0.6";
  const { app, tmpDir, setPdfText } = setupTestServer({ pdfText: "CLIENTE: Ana Test\nTOTAL: 1000.00" });
  try {
    const pedido = await crearNota(app);
    setPdfText("CLIENTE: Ana Test\nTOTAL: 300.00");
    await crearNota(app, { tipo: "bonificacion", justificacion: "regalo", notaOrigenId: pedido.id });
    setPdfText("CLIENTE: Ana Test\nTOTAL: 100.00");
    await crearNota(app, { tipo: "reposicion", justificacion: "reposicion", notaOrigenId: pedido.id });

    const kpis = (await request(app).get("/api/kpis")).body;
    assert.strictEqual(kpis.gastoBonificaciones, 180, "300 * 0.6, no el total completo de la nota");
    assert.strictEqual(kpis.gastoReposiciones, 100, "reposiciones cuentan al 100%, no llevan el descuento de proveedor de una bonificación");
  } finally {
    cleanupTestServer(tmpDir);
    if (prevFactor === undefined) delete process.env.BONIF_COST_FACTOR_PCT;
    else process.env.BONIF_COST_FACTOR_PCT = prevFactor;
  }
});
