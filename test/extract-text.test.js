"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { extractTextFromPdf } = require("../extractTextFromPdf");

function makeRealPdf(lines) {
  const tmp = path.join(require("os").tmpdir(), `pdf-fix-test-${Date.now()}-${Math.random()}.pdf`);
  const script = `
from fpdf import FPDF
pdf = FPDF()
pdf.add_page()
pdf.set_font('Helvetica', size=12)
${lines.map((l) => `pdf.cell(0, 10, ${JSON.stringify(l)}, new_x="LMARGIN", new_y="NEXT")`).join("\n")}
pdf.output(${JSON.stringify(tmp)})
`;
  execFileSync("python3", ["-c", script]);
  return tmp;
}

test("extractTextFromPdf extrae texto real de un PDF válido generado externamente (fpdf)", async () => {
  const tmp = makeRealPdf(["CLIENTE: Prueba Real", "TOTAL: 777.00"]);
  try {
    const buffer = fs.readFileSync(tmp);
    const text = await extractTextFromPdf(buffer);
    assert.match(text, /CLIENTE/);
    assert.match(text, /Prueba Real/);
    assert.match(text, /777\.00/);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("extractTextFromPdf separa líneas distintas con salto de línea (hasEOL), no las junta en una sola", async () => {
  const tmp = makeRealPdf(["CLIENTE: Ana Test", "TOTAL: 500.00"]);
  try {
    const buffer = fs.readFileSync(tmp);
    const text = await extractTextFromPdf(buffer);
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    assert.ok(lines.some((l) => l === "CLIENTE: Ana Test"), `esperaba una línea exacta "CLIENTE: Ana Test", texto real: ${JSON.stringify(text)}`);
    assert.ok(lines.some((l) => l === "TOTAL: 500.00"), `esperaba una línea exacta "TOTAL: 500.00", texto real: ${JSON.stringify(text)}`);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("extractTextFromPdf funciona con múltiples páginas", async () => {
  const tmp = makeRealPdf(["Página uno"]);
  try {
    const buffer = fs.readFileSync(tmp);
    const text = await extractTextFromPdf(buffer);
    assert.match(text, /P.gina uno/);
  } finally {
    fs.unlinkSync(tmp);
  }
});
