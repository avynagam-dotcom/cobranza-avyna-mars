"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const request = require("supertest");
const { setupTestServer, cleanupTestServer } = require("./_helpers");

function pdfBuffer() {
  return Buffer.from("%PDF-1.4 fake buffer, contenido real viene del mock de pdf-parse");
}

test("POST /api/upload sin tipo crea nota tipo='pedido' por default", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "CLIENTE: Ana Test\nTOTAL: 500.00" });
  try {
    const res = await request(app)
      .post("/api/upload")
      .attach("pdf", pdfBuffer(), "pedido.pdf");

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.nota.tipo, "pedido");
    assert.strictEqual(res.body.nota.justificacion, null);
    assert.strictEqual(res.body.nota.entregaDiferida, false);
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("POST /api/upload con tipo='bonificacion' sin justificacion → 400", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "CLIENTE: Ana Test\nTOTAL: 300.00" });
  try {
    const res = await request(app)
      .post("/api/upload")
      .field("tipo", "bonificacion")
      .attach("pdf", pdfBuffer(), "bonif.pdf");

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.ok, false);
    assert.match(res.body.message, /justificaci[oó]n/i);
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("POST /api/upload con tipo='bonificacion' + justificacion → 200, entregaDiferida=true", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "CLIENTE: Ana Test\nTOTAL: 300.00" });
  try {
    const res = await request(app)
      .post("/api/upload")
      .field("tipo", "bonificacion")
      .field("justificacion", "Shampoo dañado en tránsito, se repuso sin costo")
      .attach("pdf", pdfBuffer(), "bonif.pdf");

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.nota.tipo, "bonificacion");
    assert.strictEqual(res.body.nota.entregaDiferida, true);
    assert.strictEqual(res.body.nota.justificacion, "Shampoo dañado en tránsito, se repuso sin costo");
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("POST /api/upload con tipo inválido → 400", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "CLIENTE: Ana Test\nTOTAL: 100.00" });
  try {
    const res = await request(app)
      .post("/api/upload")
      .field("tipo", "descuento_raro")
      .attach("pdf", pdfBuffer(), "raro.pdf");

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.ok, false);
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("POST /api/upload con notaOrigenId inexistente → 400", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "CLIENTE: Ana Test\nTOTAL: 300.00" });
  try {
    const res = await request(app)
      .post("/api/upload")
      .field("tipo", "reposicion")
      .field("justificacion", "Producto llegó roto")
      .field("notaOrigenId", "id-que-no-existe")
      .attach("pdf", pdfBuffer(), "repo.pdf");

    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /notaOrigenId/i);
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("POST /api/upload con notaOrigenId apuntando a una nota que NO es pedido → 400", async () => {
  const { app, tmpDir, setPdfText } = setupTestServer({ pdfText: "CLIENTE: Ana Test\nTOTAL: 1000.00" });
  try {
    await request(app).post("/api/upload").attach("pdf", pdfBuffer(), "pedido.pdf");
    setPdfText("CLIENTE: Ana Test\nTOTAL: 200.00");
    const bonifRes = await request(app)
      .post("/api/upload")
      .field("tipo", "bonificacion")
      .field("justificacion", "regalo de temporada")
      .attach("pdf", pdfBuffer(), "bonif.pdf");

    setPdfText("CLIENTE: Ana Test\nTOTAL: 50.00");
    const res = await request(app)
      .post("/api/upload")
      .field("tipo", "reposicion")
      .field("justificacion", "otra reposición sobre una bonificación, no debe permitirse")
      .field("notaOrigenId", bonifRes.body.nota.id)
      .attach("pdf", pdfBuffer(), "repo2.pdf");

    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /notaOrigenId/i);
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("POST /api/upload con tipo='reposicion' + notaOrigenId válido de un pedido → 200, se persiste notaOrigenId", async () => {
  const { app, tmpDir, setPdfText } = setupTestServer({ pdfText: "CLIENTE: Ana Test\nTOTAL: 1000.00" });
  try {
    const pedidoRes = await request(app).post("/api/upload").attach("pdf", pdfBuffer(), "pedido.pdf");
    const origenId = pedidoRes.body.nota.id;

    setPdfText("CLIENTE: Ana Test\nTOTAL: 150.00");
    const res = await request(app)
      .post("/api/upload")
      .field("tipo", "reposicion")
      .field("justificacion", "Producto llegó dañado, se repuso")
      .field("notaOrigenId", origenId)
      .attach("pdf", pdfBuffer(), "repo.pdf");

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.nota.tipo, "reposicion");
    assert.strictEqual(res.body.nota.notaOrigenId, origenId);
  } finally {
    cleanupTestServer(tmpDir);
  }
});
