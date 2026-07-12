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

test("POST /api/notas/:id/corregir-tipo corrige un pedido mal capturado como bonificación de vuelta a pedido", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "CLIENTE: Liliana Guzman\nTOTAL: 6961.00" });
  try {
    const nota = await crearNota(app, { tipo: "bonificacion", justificacion: "Pedido Grande, mal clasificado por error" });
    assert.strictEqual(nota.tipo, "bonificacion");

    const res = await request(app)
      .post(`/api/notas/${nota.id}/corregir-tipo`)
      .send({ tipo: "pedido" });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.nota.tipo, "pedido");
    assert.strictEqual(res.body.nota.justificacion, null);
    assert.strictEqual(res.body.nota.notaOrigenId, null);
    assert.strictEqual(res.body.nota.entregaDiferida, false);
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("POST /api/notas/:id/corregir-tipo permite marcar entregado normal después de corregir a pedido", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "CLIENTE: Liliana Guzman\nTOTAL: 6961.00" });
  try {
    const nota = await crearNota(app, { tipo: "bonificacion", justificacion: "mal clasificado" });
    await request(app).post(`/api/notas/${nota.id}/corregir-tipo`).send({ tipo: "pedido" });

    const entregar = await request(app).post("/api/entregar").send({ id: nota.id });
    assert.strictEqual(entregar.status, 200);
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("POST /api/notas/:id/corregir-tipo rechaza cambiar tipo a bonificacion/reposicion sin justificación", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "CLIENTE: Ana Test\nTOTAL: 500.00" });
  try {
    const nota = await crearNota(app);

    const res = await request(app)
      .post(`/api/notas/${nota.id}/corregir-tipo`)
      .send({ tipo: "bonificacion" });

    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /justificaci[oó]n/i);
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("POST /api/notas/:id/corregir-tipo rechaza corregir una nota con pagos registrados", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "CLIENTE: Ana Test\nTOTAL: 500.00" });
  try {
    const nota = await crearNota(app);
    await request(app).post("/api/pago").send({ id: nota.id, monto: 100, metodo: "EFECTIVO" });

    const res = await request(app)
      .post(`/api/notas/${nota.id}/corregir-tipo`)
      .send({ tipo: "bonificacion", justificacion: "intento tardío" });

    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /pago/i);
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("POST /api/notas/:id/corregir-tipo sobre id inexistente devuelve 404", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "" });
  try {
    const res = await request(app)
      .post("/api/notas/no-existe/corregir-tipo")
      .send({ tipo: "pedido" });

    assert.strictEqual(res.status, 404);
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("POST /api/notas/:id/corregir-tipo con tipo inválido devuelve 400", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "CLIENTE: Ana Test\nTOTAL: 500.00" });
  try {
    const nota = await crearNota(app);

    const res = await request(app)
      .post(`/api/notas/${nota.id}/corregir-tipo`)
      .send({ tipo: "descuento_raro" });

    assert.strictEqual(res.status, 400);
  } finally {
    cleanupTestServer(tmpDir);
  }
});
