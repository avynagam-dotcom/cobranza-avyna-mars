"use strict";

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { extractTextFromPdf } = require("./extractTextFromPdf");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// C1: Auth HTTP Basic opt-in (activa solo si ADMIN_USER + ADMIN_PASS están seteadas)
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS = process.env.ADMIN_PASS;
if (ADMIN_USER && ADMIN_PASS) {
  const expectedToken = Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString('base64');
  app.use((req, res, next) => {
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Basic ') && auth.slice(6) === expectedToken) return next();
    res.set('WWW-Authenticate', 'Basic realm="Avyna Cobranza Mars"');
    return res.status(401).send('Acceso restringido');
  });
}

// Identifica quién hace la request a partir del usuario de Basic Auth (cada
// instancia — mars/backend/cha/operado — corre con su propio ADMIN_USER en
// Render, así que esto SÍ distingue quién borra qué). Sin header, "unknown".
function getAuthUser(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const [user] = decoded.split(':');
    return user || null;
  } catch {
    return null;
  }
}

const CARD_FEE_FACTOR = 0.0406; // 3.5% + 16% IVA (3.5 * 1.16 = 4.06%)
const MARGIN = parseFloat(process.env.MARGIN_PCT || '0.4');

// ----- Paths configuration (Render Persistent Disk Support)
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");

// Detectar configuración de entorno u optar por defecto local
// REGLA DE ORO: process.env.DATA_DIR es la verdad absoluta si existe.
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(DATA_DIR, "uploads");

console.log(`[System] DATA_DIR: ${DATA_DIR}`);
console.log(`[System] UPLOADS_DIR: ${UPLOADS_DIR}`);

// Asegurar existencia inmediata
if (!fs.existsSync(DATA_DIR)) {
  console.log(`[System] Creando DATA_DIR: ${DATA_DIR}`);
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(UPLOADS_DIR)) {
  console.log(`[System] Creando UPLOADS_DIR: ${UPLOADS_DIR}`);
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Re-injectar al env para consistencia en imports
process.env.DATA_DIR = DATA_DIR;
process.env.UPLOADS_DIR = UPLOADS_DIR;

// Importar persistencia DESPUÉS de definir rutas
const { saveData, appendBusinessAuditLog } = require("./utils/persistence");

const DB_FILE = "notas.json"; // persistence.js ya usa DATA_DIR

// ----- Backup Automático cada 24h a R2
const { initScheduler } = require("./utils/scheduler");

// Inicializar el Scheduler (Backup Blindado) — se omite en tests: cron.schedule()
// mantiene vivo el event loop y cuelga `node --test` indefinidamente.
if (process.env.NODE_ENV !== "test") {
  initScheduler({ dataDir: DATA_DIR, uploadsDir: UPLOADS_DIR });
}

// Ensure folders exist (Critical for new locations)
for (const dir of [DATA_DIR, UPLOADS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ----- Migration: Local/Legacy -> Persistent (Startup Logic)
try {
  const targetDB = path.join(DATA_DIR, DB_FILE);

  // Fuentes de migración en orden de prioridad
  // 1. La carpeta antigua en persistent disk (si venimos de una versión anterior)
  // 2. La carpeta data local
  // 3. La raíz (legacy muy antiguo)
  const legacySources = [
    "/var/data/cobranza/data/notas.json",
    path.join(ROOT, "data", "notas.json"),
    path.join(ROOT, "notas.json")
  ];

  if (!fs.existsSync(targetDB)) {
    console.log("[Migra] DATA_DIR vacío. Buscando datos para migrar...");

    for (const source of legacySources) {
      if (fs.existsSync(source)) {
        console.log(`[Migra] Encontrado origen válido en: ${source}`);
        try {
          fs.copyFileSync(source, targetDB);

          if (fs.existsSync(targetDB) && fs.statSync(targetDB).size > 0) {
            console.log(`[Migra] EXITO: Datos migrados a ${targetDB}`);
            break; // Ya tenemos datos, dejamos de buscar
          }
        } catch (copyErr) {
          console.error(`[Migra] Error copiando desde ${source}:`, copyErr);
        }
      }
    }
  } else {
    console.log("[Migra] DATA_DIR ya tiene datos. Omitiendo migración.");
  }

} catch (err) {
  console.error("[Migra] Error crítico en migración:", err);
}


// ----- DB helpers
function loadDB() {
  try {
    const filePath = path.join(DATA_DIR, DB_FILE);
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.map(n => ({
      ...n,
      total: (typeof n.total === 'number' && Number.isFinite(n.total)) ? n.total : null,
      pagado: (typeof n.pagado === 'number' && Number.isFinite(n.pagado)) ? n.pagado : 0,
      // Notas subidas antes de esta feature no tienen 'tipo' — deben seguir
      // contando como pedido normal, nunca desaparecer de KPIs/tablero.
      tipo: n.tipo || "pedido",
    }));
  } catch (e) {
    console.error("[DB] Error loading DB:", e.message);
    return [];
  }
}
function saveDB(notas) {
  // Usar el módulo de persistencia
  saveData(DB_FILE, JSON.stringify(notas, null, 2));
}

// ----- Batch (martes 00:00)
function pad2(n) {
  return String(n).padStart(2, "0");
}
function ymd(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function getMexicoDate(date = new Date()) {
  const options = { timeZone: "America/Mexico_City", year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' };
  const formatter = new Intl.DateTimeFormat([], options);
  const parts = formatter.formatToParts(date);
  const get = (type) => parts.find(p => p.type === type).value;

  return new Date(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
}

function getCurrentBatchKey(now = new Date()) {
  // Usar hora de México para determinar el día
  const mxDate = getMexicoDate(now);

  // martes más reciente a las 00:00 (hora México)
  // JS: 0=Dom,1=Lun,2=Mar,3=Mié...
  const day = mxDate.getDay();
  const daysSinceTuesday = (day - 2 + 7) % 7;

  const d = new Date(mxDate);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysSinceTuesday);
  return ymd(d);
}

// ----- Date helpers (crédito)
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
function iso(d) {
  return d ? new Date(d).toISOString() : null;
}

// ----- Extraction helpers
function parseMoney(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/\s/g, "");

  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  const decPos = Math.max(lastDot, lastComma);

  let normalized;
  if (decPos === -1) {
    normalized = s.replace(/[^\d]/g, "");
  } else {
    const intPart = s.slice(0, decPos).replace(/[^\d]/g, "");
    const decPart = s.slice(decPos + 1).replace(/[^\d]/g, "").slice(0, 2);
    normalized = `${intPart}.${decPart}`;
  }

  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function extractTotalFromText(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // líneas con TOTAL pero NO SUBTOTAL
  const totalLines = lines
    .filter((l) => /total/i.test(l))
    .filter((l) => !/sub\s*total/i.test(l));

  const patterns = [
    /(TOTAL\s*A\s*PAGAR)\s*[:\-]?\s*\$?\s*([0-9][0-9.,\s]*)/i,
    /(IMPORTE\s*TOTAL)\s*[:\-]?\s*\$?\s*([0-9][0-9.,\s]*)/i,
    /(^|\b)(TOTAL)\s*[:\-]?\s*\$?\s*([0-9][0-9.,\s]*)/i,
  ];

  let candidates = [];

  for (const l of totalLines) {
    for (const p of patterns) {
      const m = l.match(p);
      if (m) {
        const moneyStr = m[m.length - 1];
        const val = parseMoney(moneyStr);
        if (val != null) candidates.push(val);
      }
    }
  }

  // fallback: todo el texto (última ocurrencia)
  if (candidates.length === 0) {
    for (const p of patterns) {
      const all = [...text.matchAll(p)];
      if (all.length) {
        const last = all[all.length - 1];
        const moneyStr = last[last.length - 1];
        const val = parseMoney(moneyStr);
        if (val != null) candidates.push(val);
      }
    }
  }

  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}

function extractClienteFromText(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const sameLine = [
    /(CLIENTE)\s*[:\-]\s*(.+)$/i,
    /(NOMBRE)\s*[:\-]\s*(.+)$/i,
    /(RAZ[ÓO]N\s+SOCIAL)\s*[:\-]\s*(.+)$/i,
  ];
  for (const l of lines) {
    for (const p of sameLine) {
      const m = l.match(p);
      if (m && m[2]) {
        const v = m[2].trim();
        if (v && v.length >= 3) return v;
      }
    }
  }

  const nextLineLabels = [/^CLIENTE$/i, /^NOMBRE$/i, /^RAZ[ÓO]N\s+SOCIAL$/i];
  for (let i = 0; i < lines.length - 1; i++) {
    if (nextLineLabels.some((rx) => rx.test(lines[i]))) {
      const v = (lines[i + 1] || "").trim();
      if (v && v.length >= 3 && !/^(RFC|FECHA|FOLIO|TOTAL|SUBTOTAL)$/i.test(v)) return v;
    }
  }

  for (const l of lines) {
    const m = l.match(/^(\d{4,})\s*[-–—]\s*(.+)$/);
    if (m && m[2]) return `${m[1]} - ${m[2].trim()}`;
  }

  return null;
}

// ----- Crédito (estado en TIEMPO REAL)
function computeCredito(nota, now = new Date()) {
  const deliveredAt = nota.deliveredAt ? new Date(nota.deliveredAt) : null;
  const dueAt = nota.dueAt ? new Date(nota.dueAt) : null;

  const total = typeof nota.total === "number" && Number.isFinite(nota.total) ? nota.total : null;
  const pagado = typeof nota.pagado === "number" && Number.isFinite(nota.pagado) ? nota.pagado : 0;

  let saldo = null;
  let saldoFavor = 0;
  if (total != null) {
    saldo = Math.max(total - pagado, 0);
    saldoFavor = Math.max(pagado - total, 0);
  }

  let statusCredito = "PRE_ENTREGA";

  if (!deliveredAt && nota.tipo && nota.tipo !== "pedido") {
    statusCredito = "PENDIENTE_LIQUIDACION_ORIGEN";
  } else if (deliveredAt && nota.tipo && nota.tipo !== "pedido") {
    // Un regalo/reposición entregado nunca es deuda real — no hay nada que cobrar.
    statusCredito = "LIQUIDADO";
  } else if (deliveredAt) {
    if (saldo === 0 && total != null) {
      statusCredito = "LIQUIDADO";
    } else if (dueAt) {
      const msNow = now.getTime();
      const msDue = dueAt.getTime();
      const threeDaysMs = 3 * 24 * 60 * 60 * 1000;

      if (msNow >= msDue) statusCredito = "VENCIDO";
      else if (msNow >= msDue - threeDaysMs) statusCredito = "POR_VENCER";
      else statusCredito = "EN_PLAZO";
    } else {
      statusCredito = "EN_PLAZO";
    }
  }

  return {
    deliveredAt: nota.deliveredAt || null,
    dueAt: nota.dueAt || null,
    saldo,
    saldoFavor,
    statusCredito,
  };
}

// ----- Clasificación de notas (pedido / bonificación / reposición)
const TIPOS_NOTA = ["pedido", "bonificacion", "reposicion"];

function validateTipoYJustificacion(tipoRaw, justificacionRaw) {
  const tipo = tipoRaw && String(tipoRaw).trim() ? String(tipoRaw).trim() : "pedido";
  if (!TIPOS_NOTA.includes(tipo)) {
    return { error: "Tipo de nota inválido" };
  }
  const justificacion = justificacionRaw ? String(justificacionRaw).trim() : "";
  if (tipo !== "pedido" && !justificacion) {
    return { error: "Justificación obligatoria para bonificación/reposición" };
  }
  return { tipo, justificacion: justificacion || null };
}

function resolverNotaOrigen(notaOrigenIdRaw, notas) {
  const notaOrigenId = notaOrigenIdRaw ? String(notaOrigenIdRaw).trim() : "";
  if (!notaOrigenId) return { notaOrigenId: null };
  const origen = notas.find((n) => String(n.id) === notaOrigenId);
  if (!origen || origen.tipo !== "pedido") {
    return { error: "notaOrigenId inválido: debe referenciar una nota de tipo pedido existente" };
  }
  return { notaOrigenId };
}

// ----- Liberación automática de bonificaciones/reposiciones al liquidar su pedido de origen
function liberarBonificacionesAsociadas(notas, notaOrigenId, now = new Date()) {
  const origen = notas.find((x) => x.id === notaOrigenId);
  if (!origen) return [];
  const { saldo } = computeCredito(origen, now);
  if (saldo !== 0) return [];

  const liberadas = [];
  for (const n of notas) {
    if (n.notaOrigenId === notaOrigenId && n.tipo !== "pedido" && !n.deliveredAt && !n.deletedAt) {
      n.deliveredAt = iso(now);
      n.dueAt = null; // bonif/repo no tienen ventana de crédito de 15 días — se liquidan al entregarse
      liberadas.push(n);
    }
  }
  return liberadas;
}

// I5: Rate limiting en uploads (sin dependencias externas)
const _uploadAttempts = new Map();
function _checkUploadRate(ip) {
  const now = Date.now();
  const windowMs = 60_000;
  const limit = 20;
  const prev = (_uploadAttempts.get(ip) || []).filter(t => now - t < windowMs);
  if (prev.length >= limit) return false;
  _uploadAttempts.set(ip, [...prev, now]);
  return true;
}

// ----- Multer (PDF upload)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
});

// ----- Static
app.use(express.static(PUBLIC_DIR));

// ----- API: listar notas
app.get("/api/notas", (req, res) => {
  const notas = loadDB().filter((n) => !n.deletedAt);
  const batchKey = getCurrentBatchKey();
  const now = new Date();
  const notasWithCredito = notas.map((n) => ({ ...n, ...computeCredito(n, now) }));
  res.json({ batchKey, notas: notasWithCredito });
});

// ----- API: papelera (solo notas soft-deleted, con snapshot completo)
app.get("/api/notas/eliminadas", (req, res) => {
  const notas = loadDB().filter((n) => !!n.deletedAt);
  const now = new Date();
  const notasWithCredito = notas.map((n) => ({ ...n, ...computeCredito(n, now) }));
  res.json({ ok: true, notas: notasWithCredito });
});

// ----- API: subir PDF
app.post("/api/upload", upload.single("pdf"), async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!_checkUploadRate(ip)) {
    return res.status(429).json({ ok: false, message: "Demasiados intentos. Espera un momento." });
  }
  try {
    const batchKey = getCurrentBatchKey();

    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ ok: false, message: "No se recibió PDF" });
    }

    const originalName = req.file.originalname || "nota.pdf";
    const notas = loadDB();

    const tipoResult = validateTipoYJustificacion(req.body.tipo, req.body.justificacion);
    if (tipoResult.error) {
      return res.status(400).json({ ok: false, message: tipoResult.error });
    }
    const { tipo, justificacion } = tipoResult;

    const origenResult = resolverNotaOrigen(req.body.notaOrigenId, notas);
    if (origenResult.error) {
      return res.status(400).json({ ok: false, message: origenResult.error });
    }
    const { notaOrigenId } = origenResult;

    // ✅ Regla nueva:
    // Si hay una nota con mismo nombre EN EL BATCH:
    // - si NO está entregada => sustituir (mismo id, mismo filename, sobreescribe PDF y actualiza cliente/total)
    // - si YA está entregada => bloquear (duplicado)
    const existingIdx = notas.findIndex(
      (n) =>
        !n.deletedAt &&
        String(n.batchKey) === String(batchKey) &&
        String(n.originalName || "").toLowerCase() === String(originalName).toLowerCase()
    );

    // Parse PDF (siempre parseamos porque para sustituir necesitamos nuevo total/cliente)
    const text = (await extractTextFromPdf(req.file.buffer)) || "";
    const cliente = extractClienteFromText(text) || null;
    const total = extractTotalFromText(text);
    const uploadedAt = new Date().toISOString();

    if (existingIdx !== -1) {
      const ex = notas[existingIdx];

      // Si ya está entregada: NO se sustituye
      if (ex.deliveredAt) {
        return res.json({ ok: false, duplicate: true, message: "Nota duplicada (ya entregada)" });
      }

      // ✅ Sustituir (pre-entrega)
      // Mantener: id, pagado, deliveredAt(null), dueAt(null), firstPaymentAt, batchKey
      // Actualizar: cliente, total, uploadedAt, tipo/justificacion/notaOrigenId (permite corregir clasificación)
      ex.cliente = cliente;
      ex.total = typeof total === "number" && Number.isFinite(total) ? total : null;
      ex.uploadedAt = uploadedAt;
      ex.tipo = tipo;
      ex.justificacion = justificacion;
      ex.notaOrigenId = notaOrigenId;
      ex.entregaDiferida = tipo !== "pedido";

      // Guardar / sobreescribir el PDF usando el mismo filename de esa nota
      // (Esto mantiene tu historial limpio y evita crear 2 notas)
      const filename = ex.filename || `${batchKey}__${ex.id}__${originalName}`.replace(
        /[^\w.\-() \u00C0-\u017F]/g,
        "_"
      );
      ex.filename = filename;

      saveData(filename, req.file.buffer, UPLOADS_DIR);

      notas[existingIdx] = ex;
      saveDB(notas);

      return res.json({ ok: true, replaced: true, nota: { ...ex, ...computeCredito(ex) } });
    }

    // ✅ Nueva nota (no existe)
    const id = crypto.randomUUID();

    const safeName = `${batchKey}__${id}__${originalName}`.replace(
      /[^\w.\-() \u00C0-\u017F]/g,
      "_"
    );
    saveData(safeName, req.file.buffer, UPLOADS_DIR);

    const nota = {
      id,
      batchKey,
      originalName,
      filename: safeName,
      cliente,
      total: typeof total === "number" && Number.isFinite(total) ? total : null,
      pagado: 0,
      deliveredAt: null,
      dueAt: null,
      firstPaymentAt: null,
      uploadedAt,
      pagos: [], // historial de pagos
      tipo,
      justificacion,
      notaOrigenId,
      entregaDiferida: tipo !== "pedido",
      deletedAt: null,
      deletedBy: null,
    };

    notas.push(nota);
    // Si el pedido de origen ya está en saldo 0 (ej. bonificación subida a posteriori de liquidar),
    // liberarla de inmediato en vez de esperar al siguiente pago.
    if (notaOrigenId) liberarBonificacionesAsociadas(notas, notaOrigenId);
    saveDB(notas);

    return res.json({ ok: true, nota: { ...nota, ...computeCredito(nota) } });
  } catch (e) {
    console.error("UPLOAD ERROR:", e);
    return res.status(500).json({ ok: false, message: "Error al subir PDF" });
  }
});

// ----- API: marcar ENTREGADO (inicio crédito)
app.post("/api/entregar", (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, message: "Falta id" });

    const notas = loadDB();
    const idx = notas.findIndex((n) => String(n.id) === String(id));
    if (idx === -1) return res.status(404).json({ ok: false, message: "Nota no encontrada" });

    const n = notas[idx];

    if (!n.deliveredAt) {
      const now = new Date();
      n.deliveredAt = iso(now);
      // Bonif/repo son regalos/reposiciones — nunca generan ventana de cobranza.
      // Netie necesita marcarlas manualmente cuando entrega el producto físico,
      // sin depender de que el pedido de origen ya esté liquidado.
      n.dueAt = (n.tipo && n.tipo !== "pedido") ? null : iso(addDays(now, 14));
    }

    notas[idx] = n;
    saveDB(notas);

    return res.json({ ok: true, nota: { ...n, ...computeCredito(n) } });
  } catch (e) {
    console.error("ENTREGAR ERROR:", e);
    return res.status(500).json({ ok: false, message: "Error al marcar entregado" });
  }
});

// ----- API: registrar pago
app.post("/api/pago", (req, res) => {
  try {
    const { id, monto, metodo } = req.body || {};
    const val = Number(monto);
    const mtd = metodo || "efectivo"; // por defecto efectivo

    // Permitimos negativos (ajustes / reversos por duplicado), pero no 0.
    if (!id || !Number.isFinite(val) || val === 0) {
      return res.status(400).json({ ok: false, message: "Datos inválidos" });
    }

    const notas = loadDB();
    const idx = notas.findIndex((n) => String(n.id) === String(id));
    if (idx === -1) return res.status(404).json({ ok: false, message: "Nota no encontrada" });

    const n = notas[idx];

    // Cálculo de comisión si es tarjeta
    let comision = 0;
    if (mtd === "tarjeta") {
      comision = val * CARD_FEE_FACTOR;
    }

    // Inicializar array de pagos si no existe (retrocompatibilidad)
    if (!n.pagos) n.pagos = [];

    // Si ya tenía un valor en 'pagado' pero no en 'pagos', lo movemos como pago inicial de efectivo
    if (n.pagado > 0 && n.pagos.length === 0) {
      n.pagos.push({
        monto: n.pagado,
        metodo: "efectivo",
        comision: 0,
        fecha: n.firstPaymentAt || n.uploadedAt
      });
    }

    const nuevoPago = {
      monto: val,
      metodo: mtd,
      comision: Number(comision.toFixed(2)),
      fecha: new Date().toISOString()
    };

    n.pagos.push(nuevoPago);
    n.pagado = Number((n.pagado || 0) + val);

    // Guard: el pagado acumulado no puede quedar en negativo.
    // (Saldo a favor sí está permitido — cuando pagado > total.)
    if (n.pagado < 0) {
      n.pagos.pop();
      n.pagado = Number(n.pagado - val);
      return res.status(400).json({ ok: false, message: "El ajuste dejaría el pagado en negativo. Reduce el monto del ajuste." });
    }

    if (n.deliveredAt && !n.firstPaymentAt) {
      n.firstPaymentAt = nuevoPago.fecha;
    }

    notas[idx] = n;
    liberarBonificacionesAsociadas(notas, n.id);
    saveDB(notas);

    return res.json({ ok: true, nota: { ...n, ...computeCredito(n) } });
  } catch (e) {
    console.error("PAGO ERROR:", e);
    return res.status(500).json({ ok: false, message: "Error al registrar pago" });
  }
});

// ----- API: vincular una bonificación/reposición a su pedido de origen a posteriori
// (Mar subió solo justificación en texto libre, sin notaOrigenId estructurado)
app.post("/api/notas/:id/vincular-origen", (req, res) => {
  try {
    const { id } = req.params;
    const { notaOrigenId } = req.body || {};
    if (!notaOrigenId) return res.status(400).json({ ok: false, message: "Falta notaOrigenId" });

    const notas = loadDB();
    const idx = notas.findIndex((n) => String(n.id) === String(id));
    if (idx === -1) return res.status(404).json({ ok: false, message: "Nota no encontrada" });

    const n = notas[idx];
    if (n.tipo === "pedido") {
      return res.status(400).json({ ok: false, message: "Solo bonificaciones/reposiciones pueden vincularse a un origen" });
    }

    const origenResult = resolverNotaOrigen(notaOrigenId, notas);
    if (origenResult.error) {
      return res.status(400).json({ ok: false, message: origenResult.error });
    }

    n.notaOrigenId = origenResult.notaOrigenId;
    notas[idx] = n;
    liberarBonificacionesAsociadas(notas, n.notaOrigenId);
    saveDB(notas);

    const actualizada = notas.find((x) => x.id === n.id);
    return res.json({ ok: true, nota: { ...actualizada, ...computeCredito(actualizada) } });
  } catch (e) {
    console.error("VINCULAR-ORIGEN ERROR:", e);
    return res.status(500).json({ ok: false, message: "Error al vincular origen" });
  }
});

// ----- API: corregir la clasificación (tipo) de una nota ya capturada
// (ej. un pedido subido por error como bonificación — corrección manual, no re-upload)
app.post("/api/notas/:id/corregir-tipo", (req, res) => {
  try {
    const { id } = req.params;
    const notas = loadDB();
    const idx = notas.findIndex((n) => String(n.id) === String(id) && !n.deletedAt);
    if (idx === -1) return res.status(404).json({ ok: false, message: "Nota no encontrada" });

    const n = notas[idx];
    if (typeof n.pagado === "number" && n.pagado > 0) {
      return res.status(400).json({ ok: false, message: "No se puede corregir la clasificación de una nota con pagos registrados" });
    }

    const tipoResult = validateTipoYJustificacion(req.body.tipo, req.body.justificacion);
    if (tipoResult.error) {
      return res.status(400).json({ ok: false, message: tipoResult.error });
    }
    const { tipo, justificacion } = tipoResult;

    const origenResult = resolverNotaOrigen(req.body.notaOrigenId, notas);
    if (origenResult.error) {
      return res.status(400).json({ ok: false, message: origenResult.error });
    }

    n.tipo = tipo;
    n.justificacion = justificacion;
    n.notaOrigenId = origenResult.notaOrigenId;
    n.entregaDiferida = tipo !== "pedido";
    n.deliveredAt = null;
    n.dueAt = null;

    notas[idx] = n;
    if (n.notaOrigenId) liberarBonificacionesAsociadas(notas, n.notaOrigenId);
    saveDB(notas);

    const actualizada = notas.find((x) => x.id === n.id);
    return res.json({ ok: true, nota: { ...actualizada, ...computeCredito(actualizada) } });
  } catch (e) {
    console.error("CORREGIR-TIPO ERROR:", e);
    return res.status(500).json({ ok: false, message: "Error al corregir clasificación" });
  }
});

// ----- API: eliminar nota (soft-delete auditado — el PDF y el registro se conservan)
app.delete("/api/notas/:id", (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ ok: false, message: "Falta id" });

    const notas = loadDB();
    const idx = notas.findIndex((n) => String(n.id) === String(id));
    if (idx === -1) return res.status(404).json({ ok: false, message: "Nota no encontrada" });

    const n = notas[idx];
    n.deletedAt = new Date().toISOString();
    n.deletedBy = getAuthUser(req) || "unknown";
    notas[idx] = n;
    saveDB(notas);

    appendBusinessAuditLog("NOTA_ELIMINADA", {
      notaSnapshot: n,
      deletedBy: n.deletedBy,
    });

    return res.json({ ok: true, message: "Nota movida a papelera" });
  } catch (e) {
    console.error("DELETE ERROR:", e);
    return res.status(500).json({ ok: false, message: "Error al eliminar nota" });
  }
});

// ----- KPIs globales (SOLO ENTREGADAS) ✅ consistencia y utilidades
app.get("/api/kpis", (req, res) => {
  const notas = loadDB().filter((n) => !n.deletedAt);
  // Solo pedidos cuentan como "cobrable"/"cobrado" — bonif/repo nunca generan ingreso.
  const entregadas = notas.filter((n) => !!n.deliveredAt && n.tipo === "pedido");

  let totalCobrable = 0;
  let totalCobrado = 0;
  let totalComisiones = 0;

  for (const n of entregadas) {
    const total = typeof n.total === "number" && Number.isFinite(n.total) ? n.total : 0;
    const pagado = typeof n.pagado === "number" && Number.isFinite(n.pagado) ? n.pagado : 0;

    totalCobrable += total;
    totalCobrado += Math.min(pagado, total);

    // Sumar comisiones bancarias
    if (n.pagos) {
      for (const p of n.pagos) {
        totalComisiones += (p.comision || 0);
      }
    }
  }

  // ✅ saldo = cobrable - cobrado (evita discrepancias)
  const totalSaldo = Math.max(totalCobrable - totalCobrado, 0);
  const pctCobranza = totalCobrable > 0 ? totalCobrado / totalCobrable : 0;

  // Pulso vivo de cartera abierta (Netie 2026-07-17): el % histórico de arriba
  // suma TODAS las entregadas, incluidas las liquidadas hace meses — se queda
  // pegado arriba de 90% siempre porque lo ya cobrado nunca sale de la cuenta.
  // Esto es distinto: solo las notas que TODAVÍA tienen saldo pendiente. Una
  // nota sale de este número en cuanto se liquida, así que refleja el presente,
  // no el arrastre histórico. El histórico se conserva tal cual, sin tocar.
  let totalCobrableAbierto = 0;
  let totalCobradoAbierto = 0;
  let notasAbiertasCount = 0;
  for (const n of entregadas) {
    const total = typeof n.total === "number" && Number.isFinite(n.total) ? n.total : 0;
    const pagado = typeof n.pagado === "number" && Number.isFinite(n.pagado) ? n.pagado : 0;
    const saldo = Math.max(total - pagado, 0);
    if (saldo <= 0) continue; // ya liquidada, no es cartera abierta
    totalCobrableAbierto += total;
    totalCobradoAbierto += Math.min(pagado, total);
    notasAbiertasCount += 1;
  }
  const totalSaldoAbierto = Math.max(totalCobrableAbierto - totalCobradoAbierto, 0);
  // Sin cartera abierta = nada pendiente = 100%, no 0/0.
  const pctCobranzaAbierta = totalCobrableAbierto > 0 ? totalCobradoAbierto / totalCobrableAbierto : 1;

  // Utilidad NETA (restando comisiones bancarias del margen de utilidad bruta)
  const utilidadCobradaBruta = totalCobrado * MARGIN;
  const utilidadCobrada = Math.max(utilidadCobradaBruta - totalComisiones, 0);
  const utilidadPorCobrar = totalSaldo * MARGIN;

  // Gasto real: cuenta desde que se captura la nota — el gasto ya ocurrió al regalar/reponer
  // el producto, no cuando se libera el pedido de origen (decisión Netie 2026-07-12).
  //
  // Una bonificación NO le cuesta a Avyna el total impreso en la nota (ese es el valor
  // al público) — le cuesta un % de ese total, el costo real del proveedor. Normalmente
  // 60%, pero cambia por penalizaciones de temporada (ej. castigo de proveedor jul-dic
  // 2026: sube a 70%). Configurable vía env var BONIF_COST_FACTOR_PCT en Render — Netie
  // lo ajusta él mismo sin pedir redeploy cuando cambie la tarifa.
  // Reposiciones SÍ cuentan al 100%: reponen producto ya vendido a costo real, no llevan
  // el descuento de proveedor de una bonificación.
  const BONIF_COST_FACTOR = parseFloat(process.env.BONIF_COST_FACTOR_PCT || '0.7');
  let gastoBonificaciones = 0;
  let gastoReposiciones = 0;
  for (const n of notas) {
    const total = typeof n.total === "number" && Number.isFinite(n.total) ? n.total : 0;
    if (n.tipo === "bonificacion") gastoBonificaciones += total * BONIF_COST_FACTOR;
    if (n.tipo === "reposicion") gastoReposiciones += total;
  }

  res.json({
    ok: true,
    totalCobrable,
    totalCobrado,
    totalSaldo,
    pctCobranza,
    totalCobrableAbierto,
    totalCobradoAbierto,
    totalSaldoAbierto,
    notasAbiertasCount,
    pctCobranzaAbierta,
    utilidadCobrada,
    utilidadPorCobrar,
    totalComisiones: Number(totalComisiones.toFixed(2)),
    gastoBonificaciones,
    gastoReposiciones,
  });
});

// ----- quién falta por pagar (entregadas con saldo)
app.get("/api/faltantes", (req, res) => {
  const notas = loadDB().filter((n) => !n.deletedAt);
  const now = new Date();

  const faltantes = notas
    .filter((n) => !!n.deliveredAt && n.tipo === "pedido")
    .map((n) => ({ ...n, ...computeCredito(n, now) }))
    .filter((n) => (typeof n.saldo === "number" ? n.saldo > 0 : true))
    .sort((a, b) => {
      const rank = (s) =>
        s === "VENCIDO" ? 0 : s === "POR_VENCER" ? 1 : s === "EN_PLAZO" ? 2 : 3;
      const ra = rank(a.statusCredito);
      const rb = rank(b.statusCredito);
      if (ra !== rb) return ra - rb;

      const da = a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY;
      const db = b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY;
      return da - db;
    });

  res.json({ ok: true, faltantes });
});


// ----- Closing Control (Botón Paciente)
const CLOSING_FILE = "closing.json";
const CLOSING_DURATION_MS = 6 * 60 * 60 * 1000; // 6 horas

function loadClosingState() {
  try {
    const filePath = path.join(DATA_DIR, CLOSING_FILE);
    if (!fs.existsSync(filePath)) return { active: false, outputVisible: false, clickTimestamp: null };
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    return { active: false, outputVisible: false, clickTimestamp: null };
  }
}

function saveClosingState(state) {
  saveData(CLOSING_FILE, JSON.stringify(state, null, 2));
}

app.get("/api/closing/status", (req, res) => {
  const state = loadClosingState();
  const now = Date.now();

  if (state.clickTimestamp) {
    const elapsed = now - state.clickTimestamp;
    if (elapsed > CLOSING_DURATION_MS) {
      if (state.outputVisible) {
        state.outputVisible = false; // Expired
        saveClosingState(state);
      }
    }
  }

  // Logic: Show button if it's end of month OR if timer is active
  // But the requirement says: "appears end of month... Click -> 6 hours -> hides"
  // So:
  // 1. If not clicked yet: Visible if End of Month (calculated by client, verified here optional)
  // 2. If clicked: Visible if within 6h.

  res.json({
    ok: true,
    active: state.outputVisible,
    clickTimestamp: state.clickTimestamp,
    remainingMs: state.clickTimestamp ? Math.max(0, (state.clickTimestamp + CLOSING_DURATION_MS) - now) : 0
  });
});

app.post("/api/closing/start", (req, res) => {
  const state = loadClosingState();
  const now = Date.now();

  if (!state.clickTimestamp) {
    state.clickTimestamp = now;
    state.outputVisible = true;
    saveClosingState(state);
  }

  res.json({ ok: true, state });
});

// ----- Start
const PORT = process.env.PORT || 4000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
    console.log(`Batch actual (martes 00:00): ${getCurrentBatchKey()}`);
  });
}

module.exports = app;