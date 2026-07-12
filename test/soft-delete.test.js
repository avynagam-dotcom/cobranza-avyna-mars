"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
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

test("DELETE /api/notas/:id no borra el PDF físico", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "CLIENTE: Ana Test\nTOTAL: 500.00" });
  try {
    const nota = await crearNota(app);
    const filePath = path.join(process.env.UPLOADS_DIR, nota.filename);
    assert.ok(fs.existsSync(filePath), "el PDF debe existir antes de borrar");

    const res = await request(app).delete(`/api/notas/${nota.id}`);
    assert.strictEqual(res.status, 200);
    assert.ok(fs.existsSync(filePath), "el PDF NO debe borrarse en soft-delete");
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("DELETE /api/notas/:id marca deletedAt y deletedBy", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "CLIENTE: Ana Test\nTOTAL: 500.00" });
  try {
    const nota = await crearNota(app);
    await request(app).delete(`/api/notas/${nota.id}`);

    const dataRaw = fs.readFileSync(path.join(process.env.DATA_DIR, "notas.json"), "utf8");
    const notas = JSON.parse(dataRaw);
    const borrada = notas.find((n) => n.id === nota.id);

    assert.ok(borrada, "la nota debe seguir existiendo en notas.json");
    assert.ok(borrada.deletedAt, "deletedAt debe estar seteado");
    assert.strictEqual(borrada.deletedBy, "unknown");
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("GET /api/notas ya no incluye una nota borrada", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "CLIENTE: Ana Test\nTOTAL: 500.00" });
  try {
    const nota = await crearNota(app);
    await request(app).delete(`/api/notas/${nota.id}`);

    const res = await request(app).get("/api/notas");
    assert.strictEqual(res.status, 200);
    assert.ok(!res.body.notas.some((n) => n.id === nota.id));
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("GET /api/notas/eliminadas sí incluye la nota borrada con snapshot completo", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "CLIENTE: Ana Test\nTOTAL: 500.00" });
  try {
    const nota = await crearNota(app);
    await request(app).delete(`/api/notas/${nota.id}`);

    const res = await request(app).get("/api/notas/eliminadas");
    assert.strictEqual(res.status, 200);
    const borrada = res.body.notas.find((n) => n.id === nota.id);
    assert.ok(borrada, "debe aparecer en eliminadas");
    assert.strictEqual(borrada.cliente, "Ana Test");
    assert.strictEqual(borrada.total, 500);
    assert.ok(borrada.deletedAt);
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("DELETE escribe una línea en business-audit.jsonl", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "CLIENTE: Ana Test\nTOTAL: 500.00" });
  try {
    const nota = await crearNota(app);
    await request(app).delete(`/api/notas/${nota.id}`);

    const auditPath = path.join(process.env.DATA_DIR, "business-audit.jsonl");
    assert.ok(fs.existsSync(auditPath), "business-audit.jsonl debe crearse");
    const lines = fs.readFileSync(auditPath, "utf8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]);
    assert.strictEqual(last.action, "NOTA_ELIMINADA");
    assert.strictEqual(last.notaSnapshot.id, nota.id);
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("Subir mismo filename+batch DESPUÉS de borrar la nota crea una nota NUEVA activa, no resucita la borrada", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "CLIENTE: Ana Test\nTOTAL: 500.00" });
  try {
    const nota = await crearNota(app);
    await request(app).delete(`/api/notas/${nota.id}`);

    const res = await request(app)
      .post("/api/upload")
      .attach("pdf", pdfBuffer(), "nota.pdf");

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.notStrictEqual(res.body.nota.id, nota.id, "debe crear una nota nueva, no resucitar la borrada");
    assert.strictEqual(res.body.nota.deletedAt, null);

    const list = await request(app).get("/api/notas");
    assert.ok(list.body.notas.some((n) => n.id === res.body.nota.id), "la nota nueva debe aparecer en /api/notas");

    const trash = await request(app).get("/api/notas/eliminadas");
    assert.ok(trash.body.notas.some((n) => n.id === nota.id), "la nota vieja debe seguir intacta en la papelera");
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("DELETE sobre un id inexistente sigue devolviendo 404", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "" });
  try {
    const res = await request(app).delete("/api/notas/no-existe");
    assert.strictEqual(res.status, 404);
  } finally {
    cleanupTestServer(tmpDir);
  }
});
