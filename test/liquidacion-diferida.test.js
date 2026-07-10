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

test("POST /api/entregar rechaza notas tipo bonificacion/reposicion (400)", async () => {
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
    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /autom[aá]tica/i);
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
    // La bonificación ya se liberó (deliveredAt) porque el pedido llegó a saldo 0 → cuenta en gastoBonificaciones
    assert.strictEqual(kpis.gastoBonificaciones, 200);
    assert.strictEqual(kpis.gastoReposiciones, 0);
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("GET /api/kpis no cuenta gasto de bonificación aún no liberada (pedido de origen sin liquidar)", async () => {
  const { app, tmpDir, setPdfText } = setupTestServer({ pdfText: "CLIENTE: Ana Test\nTOTAL: 1000.00" });
  try {
    const pedido = await crearNota(app);
    setPdfText("CLIENTE: Ana Test\nTOTAL: 200.00");
    await crearNota(app, { tipo: "bonificacion", justificacion: "regalo", notaOrigenId: pedido.id });

    const kpis = (await request(app).get("/api/kpis")).body;
    assert.strictEqual(kpis.gastoBonificaciones, 0, "el gasto no es real hasta que se libera");
  } finally {
    cleanupTestServer(tmpDir);
  }
});
