"use strict";

/**
 * Extrae texto plano de un PDF. pdf-parse@1.1.4 (paquete abandonado) bundlea
 * pdfjs-dist v1.9-v2.0 y falla con "bad XRef entry" en Node 22 incluso con
 * PDFs válidos — reemplazado por pdfjs-dist directo (mantenido, oficial).
 * Solo texto, sin canvas/rendering — build "legacy" pensado para Node sin DOM.
 */
async function extractTextFromPdf(buffer) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
  });

  const pdfDocument = await loadingTask.promise;
  const pageTexts = [];

  for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
    const page = await pdfDocument.getPage(pageNum);
    const textContent = await page.getTextContent();
    // pdfjs marca fin de línea real con hasEOL — sin esto, "CLIENTE: X" y
    // "TOTAL: Y" en líneas separadas del PDF se pegan en un solo renglón y
    // rompen las regex de extractClienteFromText/extractTotalFromText que
    // dependen de split por línea.
    let pageText = "";
    for (const item of textContent.items) {
      pageText += item.str + (item.hasEOL ? "\n" : " ");
    }
    pageTexts.push(pageText);
  }

  await loadingTask.destroy();

  return pageTexts.join("\n");
}

module.exports = { extractTextFromPdf };
