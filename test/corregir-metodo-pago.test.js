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
  const res = await req.attach("pdf", pdfBuffer(), "nota.pdf");
  return res.body.nota;
}

// Origen: 2026-08-10, Esmeralda Quiroz — pago real fue transferencia, quedó
// capturado como efectivo. cobrado_en_cih_vs_pendiente() en money-coach/engine.py
// trata TODO efectivo cobrado por Mar como "pendiente de depósito" hasta que
// se deposite físicamente — con el método mal capturado, dinero que ya está en
// banco aparece como cash suelto en manos de Mar. Netie: corregirlo en el dato,
// no solo llevarlo de memoria en cada conciliación, y sin exponer un botón de
// autocorrección a Mar en su UI (no se toca public/index.html).
test("POST /api/notas/:id/corregir-metodo-pago corrige el método de un pago existente", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "CLIENTE: Esmeralda Quiroz\nTOTAL: 3336.00" });
  try {
    const nota = await crearNota(app);
    await request(app).post("/api/entregar").send({ id: nota.id });
    const pago = await request(app).post("/api/pago").send({ id: nota.id, monto: 3336, metodo: "efectivo" });
    const fecha = pago.body.nota.pagos[0].fecha;

    const res = await request(app)
      .post(`/api/notas/${nota.id}/corregir-metodo-pago`)
      .send({ pagoFecha: fecha, metodoNuevo: "transferencia" });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    const pagoCorregido = res.body.nota.pagos.find((p) => p.fecha === fecha);
    assert.strictEqual(pagoCorregido.metodo, "transferencia");
    assert.strictEqual(pagoCorregido.comision, 0);
    assert.strictEqual(pagoCorregido.monto, 3336);
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("POST /api/notas/:id/corregir-metodo-pago recalcula comisión al corregir hacia/desde tarjeta", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "CLIENTE: Ana Test\nTOTAL: 1000.00" });
  try {
    const nota = await crearNota(app);
    await request(app).post("/api/entregar").send({ id: nota.id });
    const pago = await request(app).post("/api/pago").send({ id: nota.id, monto: 1000, metodo: "efectivo" });
    const fecha = pago.body.nota.pagos[0].fecha;

    const res = await request(app)
      .post(`/api/notas/${nota.id}/corregir-metodo-pago`)
      .send({ pagoFecha: fecha, metodoNuevo: "tarjeta" });

    assert.strictEqual(res.status, 200);
    const pagoCorregido = res.body.nota.pagos.find((p) => p.fecha === fecha);
    assert.strictEqual(pagoCorregido.metodo, "tarjeta");
    assert.strictEqual(pagoCorregido.comision, Number((1000 * 0.0406).toFixed(2)));
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("POST /api/notas/:id/corregir-metodo-pago sobre nota inexistente devuelve 404", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "" });
  try {
    const res = await request(app)
      .post("/api/notas/no-existe/corregir-metodo-pago")
      .send({ pagoFecha: "2026-08-10T00:00:00.000Z", metodoNuevo: "transferencia" });

    assert.strictEqual(res.status, 404);
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("POST /api/notas/:id/corregir-metodo-pago sobre fecha de pago inexistente devuelve 404", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "CLIENTE: Ana Test\nTOTAL: 500.00" });
  try {
    const nota = await crearNota(app);
    await request(app).post("/api/entregar").send({ id: nota.id });
    await request(app).post("/api/pago").send({ id: nota.id, monto: 500, metodo: "efectivo" });

    const res = await request(app)
      .post(`/api/notas/${nota.id}/corregir-metodo-pago`)
      .send({ pagoFecha: "2020-01-01T00:00:00.000Z", metodoNuevo: "transferencia" });

    assert.strictEqual(res.status, 404);
    assert.match(res.body.message, /pago/i);
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("POST /api/notas/:id/corregir-metodo-pago con método inválido devuelve 400", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "CLIENTE: Ana Test\nTOTAL: 500.00" });
  try {
    const nota = await crearNota(app);
    await request(app).post("/api/entregar").send({ id: nota.id });
    const pago = await request(app).post("/api/pago").send({ id: nota.id, monto: 500, metodo: "efectivo" });
    const fecha = pago.body.nota.pagos[0].fecha;

    const res = await request(app)
      .post(`/api/notas/${nota.id}/corregir-metodo-pago`)
      .send({ pagoFecha: fecha, metodoNuevo: "bitcoin" });

    assert.strictEqual(res.status, 400);
  } finally {
    cleanupTestServer(tmpDir);
  }
});
