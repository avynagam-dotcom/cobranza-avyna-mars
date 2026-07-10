"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { mock } = require("node:test");

/**
 * Prepara un DATA_DIR/UPLOADS_DIR temporal y aislado, mockea extractTextFromPdf
 * (para tests rápidos y deterministas sin depender de generar PDFs reales en
 * cada test — la extracción real ya se verifica aparte en extract-text.test.js
 * contra PDFs generados con fpdf), y devuelve la app de Express fresca.
 *
 * Debe llamarse ANTES de cualquier require('../server') en el archivo de test.
 */
let extractTextMock = null;

function setupTestServer({ pdfText = "" } = {}) {
  process.env.NODE_ENV = "test";
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cobranza-mars-test-"));
  process.env.DATA_DIR = path.join(tmpDir, "data");
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

  process.env.UPLOADS_DIR = path.join(tmpDir, "uploads");
  fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });

  if (!extractTextMock) {
    extractTextMock = mock.fn(async () => pdfText);
    mock.module(require.resolve("../extractTextFromPdf"), {
      namedExports: { extractTextFromPdf: extractTextMock },
    });
  } else {
    extractTextMock.mock.mockImplementation(async () => pdfText);
  }

  delete require.cache[require.resolve("../server")];
  const app = require("../server");

  return { app, tmpDir, extractTextMock, setPdfText: (t) => extractTextMock.mock.mockImplementation(async () => t) };
}

function cleanupTestServer(tmpDir) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

module.exports = { setupTestServer, cleanupTestServer };
