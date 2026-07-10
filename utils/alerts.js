"use strict";

/**
 * Alerta inmediata a Netie por email (Resend REST API directa, sin SDK).
 * Fallas de envío NUNCA deben tumbar la operación de negocio que las dispara
 * (upload/delete) — el caller siempre debe envolver la llamada en .catch().
 */
async function enviarAlertaEmail({ tipo, nota }) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    console.warn("[Alerta] RESEND_API_KEY no configurada, se omite envío.");
    return;
  }

  const ALERT_EMAIL_FROM = process.env.ALERT_EMAIL_FROM;
  const ALERT_EMAIL_TO = process.env.ALERT_EMAIL_TO || "ernesto.velez.gtz@gmail.com";

  const nombreCliente = nota.cliente || nota.originalName || "Sin nombre";
  const money = (v) => (typeof v === "number" ? `$${v.toLocaleString("es-MX", { minimumFractionDigits: 2 })}` : "-");

  let asunto, tituloTipo;
  if (tipo === "BORRADO") {
    asunto = `🗑️ Nota eliminada: ${nombreCliente}`;
    tituloTipo = "Nota eliminada (soft-delete)";
  } else {
    tituloTipo = nota.tipo === "reposicion" ? "REPOSICIÓN" : "BONIFICACIÓN";
    asunto = `⚠️ Nueva ${tituloTipo}: ${nombreCliente}`;
  }

  const cuerpo = `
    <div style="font-family: sans-serif">
      <h2>${tituloTipo}</h2>
      <p><strong>Cliente:</strong> ${nombreCliente}</p>
      <p><strong>Total:</strong> ${money(nota.total)}</p>
      ${nota.tipo ? `<p><strong>Tipo:</strong> ${nota.tipo}</p>` : ""}
      ${nota.justificacion ? `<p><strong>Justificación:</strong> ${nota.justificacion}</p>` : ""}
      ${nota.notaOrigenId ? `<p><strong>Nota de origen:</strong> ${nota.notaOrigenId}</p>` : ""}
      ${nota.deletedBy ? `<p><strong>Borrado por:</strong> ${nota.deletedBy}</p>` : ""}
      <p style="opacity:0.6">${new Date().toLocaleString("es-MX")}</p>
    </div>
  `;

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: ALERT_EMAIL_FROM,
      to: [ALERT_EMAIL_TO],
      subject: asunto,
      html: cuerpo,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Resend API error ${resp.status}: ${errText}`);
  }
}

module.exports = { enviarAlertaEmail };
