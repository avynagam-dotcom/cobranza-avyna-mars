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

// Borrado con razón (2026-09-28): DELETE exige quién + por qué.
const BORRADO_OK = { quien: "Mar", razon: "La clienta canceló el pedido" };
function borrar(app, id, body = BORRADO_OK) {
  return request(app).delete(`/api/notas/${id}`).send(body);
}

test("DELETE /api/notas/:id no borra el PDF físico", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "CLIENTE: Ana Test\nTOTAL: 500.00" });
  try {
    const nota = await crearNota(app);
    const filePath = path.join(process.env.UPLOADS_DIR, nota.filename);
    assert.ok(fs.existsSync(filePath), "el PDF debe existir antes de borrar");

    const res = await borrar(app, nota.id);
    assert.strictEqual(res.status, 200);
    assert.ok(fs.existsSync(filePath), "el PDF NO debe borrarse en soft-delete");
  } finally {
    cleanupTestServer(tmpDir);
  }
});

function escribirNotaDirecta(overrides = {}) {
  const dbFile = path.join(process.env.DATA_DIR, "notas.json");
  const nota = {
    id: "nota-directa-1",
    cliente: "Ana Test",
    total: 500,
    pagado: 0,
    tipo: "pedido",
    deliveredAt: new Date().toISOString(),
    ...overrides,
  };
  fs.writeFileSync(dbFile, JSON.stringify([nota], null, 2));
  return nota;
}

function leerNota(id) {
  const notas = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, "notas.json"), "utf8"));
  return notas.find((n) => n.id === id);
}

// Origen 2026-09-28: cadena anti-robo de Netie. Tres borrados en el tablero de
// Netie quedaron con deletedBy="unknown" y sin razón. Desde ahora DELETE exige
// "quien" (lista fija por tablero) y "razon" (10-300 caracteres). Sin eso: 400
// y la nota NO se borra.
test("DELETE sin quién ni razón → 400 y la nota sigue activa", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "" });
  try {
    const nota = escribirNotaDirecta();
    const res = await request(app).delete(`/api/notas/${nota.id}`);

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.ok, false);
    assert.match(res.body.message, /quién/i);
    assert.strictEqual(leerNota(nota.id).deletedAt, undefined, "la nota NO debe borrarse");

    const list = await request(app).get("/api/notas");
    assert.ok(list.body.notas.some((n) => n.id === nota.id), "debe seguir en /api/notas");
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("DELETE con quién válido pero sin razón → 400 y la nota sigue activa", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "" });
  try {
    const nota = escribirNotaDirecta();
    const res = await borrar(app, nota.id, { quien: "Mar" });

    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /por qué/i);
    assert.strictEqual(leerNota(nota.id).deletedAt, undefined);
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("DELETE con razón de menos de 10 caracteres (tras recortar espacios) → 400", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "" });
  try {
    const nota = escribirNotaDirecta();
    const res = await borrar(app, nota.id, { quien: "Mar", razon: "   error   " });

    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /10 caracteres/);
    assert.strictEqual(leerNota(nota.id).deletedAt, undefined);
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("DELETE con razón de más de 300 caracteres → 400", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "" });
  try {
    const nota = escribirNotaDirecta();
    const res = await borrar(app, nota.id, { quien: "Mar", razon: "x".repeat(301) });

    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /300 caracteres/);
    assert.strictEqual(leerNota(nota.id).deletedAt, undefined);
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("DELETE con quién fuera de la lista del tablero → 400 y la nota sigue activa", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "" });
  try {
    const nota = escribirNotaDirecta();
    const res = await borrar(app, nota.id, { quien: "Pedro", razon: "La clienta canceló el pedido" });

    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /Mar, Netie/);
    assert.strictEqual(leerNota(nota.id).deletedAt, undefined);
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("DELETE con quién + razón válidos → soft-delete con deletedBy, deleteReason (recortada) y deleteMeta", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "" });
  try {
    const nota = escribirNotaDirecta();
    const res = await borrar(app, nota.id, { quien: "Mar", razon: "  Nota duplicada, se subió dos veces  " })
      .set("User-Agent", "PruebaNavegador/1.0");

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    const borrada = leerNota(nota.id);
    assert.ok(borrada.deletedAt, "deletedAt debe estar seteado");
    assert.strictEqual(borrada.deletedBy, "Mar");
    assert.strictEqual(borrada.deleteReason, "Nota duplicada, se subió dos veces");
    assert.ok(borrada.deleteMeta, "deleteMeta debe existir");
    assert.strictEqual(borrada.deleteMeta.userAgent, "PruebaNavegador/1.0");
    assert.ok("ip" in borrada.deleteMeta, "deleteMeta.ip debe registrarse");
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("DELETE en el tablero de Mar acepta también a Netie como quién", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "" });
  try {
    const nota = escribirNotaDirecta();
    const res = await borrar(app, nota.id, { quien: "Netie", razon: "Nota duplicada en el tablero" });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(leerNota(nota.id).deletedBy, "Netie");
  } finally {
    cleanupTestServer(tmpDir);
  }
});

// Origen 2026-07-17: el usuario de Basic Auth se conserva como evidencia de
// apoyo (deleteMeta.authUser), pero ya no sustituye al "quien" declarado.
test("DELETE conserva el usuario de Basic Auth en deleteMeta.authUser; deletedBy es el quién declarado", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "" });
  try {
    const nota = escribirNotaDirecta({ id: "nota-directa-2" });
    await borrar(app, nota.id).auth("mar", "loquesea");

    const borrada = leerNota(nota.id);
    assert.strictEqual(borrada.deletedBy, "Mar");
    assert.strictEqual(borrada.deleteMeta.authUser, "mar");
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("GET /api/notas/eliminadas devuelve deletedBy y deleteReason", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "" });
  try {
    const nota = escribirNotaDirecta();
    await borrar(app, nota.id, { quien: "Mar", razon: "Se cambió por otra nota" });

    const res = await request(app).get("/api/notas/eliminadas");
    const borrada = res.body.notas.find((n) => n.id === nota.id);
    assert.ok(borrada);
    assert.strictEqual(borrada.deletedBy, "Mar");
    assert.strictEqual(borrada.deleteReason, "Se cambió por otra nota");
    assert.strictEqual(borrada.deleteMeta, undefined, "la papelera pública no expone IP ni navegador de quien borró");
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("Notas borradas antes del cambio conservan deletedBy 'unknown' y un segundo DELETE no las reescribe", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "" });
  try {
    const deletedAt = "2026-09-27T18:00:00.000Z";
    const nota = escribirNotaDirecta({ deletedAt, deletedBy: "unknown" });

    const res = await borrar(app, nota.id);
    assert.strictEqual(res.status, 409);

    const vieja = leerNota(nota.id);
    assert.strictEqual(vieja.deletedAt, deletedAt);
    assert.strictEqual(vieja.deletedBy, "unknown");
    assert.strictEqual(vieja.deleteReason, undefined);

    const trash = await request(app).get("/api/notas/eliminadas");
    const enPapelera = trash.body.notas.find((n) => n.id === nota.id);
    assert.strictEqual(enPapelera.deletedBy, "unknown");
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("La auditoría de NOTA_ELIMINADA registra quién y por qué", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "" });
  try {
    const nota = escribirNotaDirecta();
    await borrar(app, nota.id);

    const auditPath = path.join(process.env.DATA_DIR, "business-audit.jsonl");
    const lines = fs.readFileSync(auditPath, "utf8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]);
    assert.strictEqual(last.action, "NOTA_ELIMINADA");
    assert.strictEqual(last.deletedBy, "Mar");
    assert.strictEqual(last.deleteReason, "La clienta canceló el pedido");
  } finally {
    cleanupTestServer(tmpDir);
  }
});

test("GET /api/notas ya no incluye una nota borrada", async () => {
  const { app, tmpDir } = setupTestServer({ pdfText: "CLIENTE: Ana Test\nTOTAL: 500.00" });
  try {
    const nota = await crearNota(app);
    await borrar(app, nota.id);

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
    await borrar(app, nota.id);

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
    await borrar(app, nota.id);

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
    await borrar(app, nota.id);

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
