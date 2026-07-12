# project_state.md — cobranza-avyna-mars
> Creado: 2026-05-01 (paridad con backend) | Última actualización: 2026-07-12 (fix: gasto en bonificaciones usaba el valor de la nota en vez del costo real)

---

## Sesión 2026-07-12 (7) — Gasto en bonificaciones calculaba mal: usaba el total de la nota, no el costo real

**Reportado por Netie:** el KPI "Gasto en bonificaciones" mostraba el 100% del valor impreso en la nota. Su costo real normalmente es 60% de ese valor — nunca el 100% — y actualmente (penalización temporal de proveedor) es 70%.

**Fix:** nueva constante `BONIF_COST_FACTOR_PCT` (env var, mismo patrón que `MARGIN_PCT` ya existente en el código) — default `0.7` (la tarifa vigente ahora). `gastoBonificaciones = total * BONIF_COST_FACTOR`. Netie ajusta el valor él mismo en Render cuando cambie la tarifa, sin pedir redeploy. **Decisión de scope (no confirmada explícitamente por Netie, aplicar con criterio):** reposiciones se dejaron al 100% del valor de la nota — reponen producto ya vendido a costo real, no llevan el descuento de proveedor de una bonificación. Si esto está mal, avisar para corregir.

TDD: 3 tests actualizados/nuevos (factor aplicado, configurable por env var, reposiciones sin cambio), 31/31 en verde. Replicado idéntico en `cobranza-avyna-backend`.

---

## Sesión 2026-07-12 (6) — Corrección de rumbo: el fix anterior (sesión 5) estaba mal enfocado

Réplica exacta de `cobranza-avyna-backend`. Netie: el click en bonificación debía marcar entregado (caso común, diario), no abrir corrección de clasificación (caso raro). `POST /api/entregar` ahora acepta cualquier tipo, sin `dueAt` para bonif/repo. Buscador de origen (texto filtrando un select cerrado, invisible) reemplazado por `<input list="datalist">` nativo con sugerencias en vivo. 30/30 tests en verde, verificado en navegador real. Ver detalle completo de la lección en `project_state.md` de backend.

---

## Sesión 2026-07-12 (5) — 2 fixes de fricción real reportados en vivo por Netie

Réplica exacta de `cobranza-avyna-backend`. (1) La píldora de estado "Bonificación pendiente" ahora también abre el modal de corrección (antes solo el badge junto al nombre). (2) `.uploader` con `flex-wrap` — el botón "Seleccionar PDF" se salía del recuadro al cambiar a Bonificación por los campos nuevos de la sesión anterior. Verificado en navegador real, 30/30 tests en verde.

---

## Sesión 2026-07-12 (4) — Bug real en producción: pedido grande capturado por error como bonificación, sin forma de corregirlo

Réplica exacta de `cobranza-avyna-backend`. Netie reportó (con screenshot) un pedido real de Liliana Guzman ($6,961) mal clasificado como bonificación, sin botón de "marcar entregado" y sin forma de corregirlo salvo borrar/resubir. Nuevo endpoint `POST /api/notas/:id/corregir-tipo` (bloqueado si ya tiene pagos registrados) + modal "Corregir clasificación" activado al click en el badge 🎁/🔄 (antes no hacía nada). También fix de `margin-left` en `.badgeTipo` (texto pegado al nombre del cliente). 30/30 tests en verde.

---

## Sesión 2026-07-12 (3) — Decisión de negocio resuelta: gasto en bonificaciones/reposiciones cuenta desde que se captura

Réplica exacta del cambio en `cobranza-avyna-backend`. Decisión de Netie: el gasto se materializa al regalar/reponer el producto, no cuando se libera. `gastoBonificaciones`/`gastoReposiciones` ya no filtran por `deliveredAt`; una bonif/repo liberada siempre es `statusCredito: "LIQUIDADO"`; el label de `PENDIENTE_LIQUIDACION_ORIGEN` ahora dice "🎁 Bonificación pendiente" / "🔄 Reposición pendiente". 24/24 tests en verde.

---

## Sesión 2026-07-12 (2) — Fix crítico: nota borrada + resubida quedaba invisible en papelera (dinero fantasma)

Réplica exacta del fix aplicado en `cobranza-avyna-backend`. La lógica de "sustituir nota existente" en `POST /api/upload` no excluía notas soft-deleted (`deletedAt`) — borrar una nota mal capturada y resubir el mismo PDF la resucitaba silenciosamente sin limpiar `deletedAt`: quedaba invisible, sin contar en ningún KPI, sin poder recuperarla desde la UI. Fix: excluir `!n.deletedAt` del match. Test TDD agregado, 23/23 en verde.

Además: buscador (`#origenSearch`) en el selector de nota de origen, y el contador "Pendientes" del header ahora excluye bonificaciones/reposiciones.

**Pregunta de negocio abierta (ver detalle en `project_state.md` de backend):** ¿el KPI de gasto en bonificaciones debe contar desde que se captura, o solo cuando se libera (diseño actual)?

---

## Sesión 2026-07-12 — Fix: "ID del pedido de origen" era un campo imposible de llenar

**Bug reportado por Netie:** al subir una nota como bonificación, tras llenar justificación y "a qué nota está asociado" pegando el número de venta impreso en la nota, el upload fallaba con error.

**Causa raíz (no era bug de backend):** el campo `notaOrigenIdInput` era un input de texto libre con placeholder "ID del pedido de origen" que esperaba el UUID interno generado por el sistema (`crypto.randomUUID()`) — un valor que NUNCA se muestra en la UI y que el sistema tampoco extrae del PDF. El "número de venta" que Netie/Mar pegaban ahí es un dato que este sistema ni siquiera captura. `resolverNotaOrigen()` en el backend hacía bien su trabajo (rechazar IDs que no existen) — el problema era pedirle a un humano un dato que no tenía forma de conocer.

**Fix:** `notaOrigenIdInput` pasó de `<input type="text">` a `<select>` poblado con las notas tipo "pedido" existentes (`cliente — total`), function `populateOrigenSelect()`. El usuario elige de una lista visible; el `value` real (UUID) se resuelve solo. Replicado idéntico en `cobranza-avyna-backend`. 22/22 tests en verde en ambos (backend no cambió, solo frontend). Verificado end-to-end con navegador real (Chrome DevTools MCP): bonificación subida con nota de origen seleccionada → "PDF recibido correctamente ✓", badge 🎁 y estado "Espera liquidación de origen".

---

## Sesión 2026-07-10 (tarde) — Restauración manual de notas borradas por error

Mar borró 3 notas. Restauradas 2 en producción vía comando one-off en Render Shell (respaldo previo de `notas.json`, `deletedAt=null` por ID exacto): **Antonia Herros $1,460** (conservaba pago de $730 registrado — restaurar, no resubir, para no perderlo) y **Esmeralda Quiroz $3,336** (queda en pre-entrega sola porque `deliveredAt` ya era null). Dejada borrada la duplicada **Antonia $1,414** (sin pagos, borrado justificado — existe la buena en batch normal). Verificado por GET `/api/notas/eliminadas` y `/api/notas`.

**Confirmado hueco de UX:** no hay endpoint/botón para restaurar desde papelera. Netie decidió NO construir feature (pasa muy poco). Render CLI instalado en la laptop (v2.21.0) para futuras restauraciones sin Shell manual, tras `render login`. URL prod: `cobranza-avyna-mars.onrender.com`.

---

## Sesión 2026-07-10 — Clasificación de notas, soft-delete, y fix crítico de upload

Réplica exacta del patch aplicado en `cobranza-avyna-backend` (clasificación bonif/repo, soft-delete auditado, liquidación diferida, KPIs de gasto — respetando la lógica de comisión de tarjeta 4.06% ya existente en Mars). 22/22 tests en verde. Además reemplazado `pdf-parse` (roto en Node 22, ver detalle en `project_state.md` de backend) por `pdfjs-dist@6.1.200` vía `extractTextFromPdf.js` — verificado con upload real por `curl`.

**Alerta por email descartada (decisión Netie, mismo día):** se construyó y luego se eliminó por completo `utils/alerts.js` (Resend) — Netie ya tiene demasiadas notificaciones de otros ecosistemas. El aviso de cada borrado vive ahora en la conciliación semanal (`avyna-conciliacion-cobranza`), no en notificaciones activas.

---

## ¿Qué es este proyecto?

Clon del sistema **cobranza-avyna-backend**, creado para la operación Mars de Avyna. Misma arquitectura: Node.js/Express, Render Persistent Disk, Cloudflare R2. **Backend fue la base original** — mantener paridad entre los 3 sistemas (backend, mars, operado).

**Stack:** Node.js · Express · Multer · PDF-parse · AWS S3 Client (R2) · node-cron · Render (hosting)

---

## Estado actual

### Funcionalidades implementadas ✅

| Feature | Estado |
|---------|--------|
| CRUD de notas de cobranza (notas.json) | ✅ Funcional |
| Subida de evidencias (uploads/) | ✅ Funcional |
| Parsing de PDFs | ✅ Funcional |
| Historial de pagos + método (efectivo/tarjeta/transferencia) | ✅ Funcional |
| Comisión bancaria 4.06% en pagos con tarjeta | ✅ Funcional |
| Bóveda mensual (snapshot automático 1ro de mes) | ✅ Funcional |
| Closing Control (botón reporte fin de mes, timer 6h) | ✅ Funcional |
| Backup automático a Cloudflare R2 | ✅ Funcional |
| Scheduler diario (09:00 UTC / 3:00 AM CDMX) | ✅ Funcional |
| Persistent Disk de Render (auto-detect) | ✅ Funcional |
| Vista "Ver quién falta" — vencidos primero + cuadrito | ✅ Funcional (2026-05-01) |
| Auth HTTP Basic opt-in (ADMIN_USER/ADMIN_PASS) | ✅ Implementado (inactivo) |
| Rate limiting en uploads (20/min por IP) | ✅ Funcional |
| Cleanup diario de PDFs huérfanos | ✅ Funcional |
| KPI cards responsive (números grandes no desbordan) | ✅ Funcional |
| Eliminación de notas con confirmación | ✅ Funcional |
| VIP detection por volumen mensual | ✅ Funcional |

---

## Sesión 2026-05-01 — Paridad con backend

### Commit `ed794ac` — Parity completo
| Fix | Detalle |
|-----|---------|
| Frontend: sort vencidos | VENCIDO → POR_VENCER → EN_PLAZO, por saldo desc dentro del grupo |
| Frontend: cuadrito rojo | Monto recuperable de vencidos + conteo de clientes |
| C1: Auth | HTTP Basic opcional via `ADMIN_USER`+`ADMIN_PASS` |
| C2: Command injection | `execSync` → `spawnSync` array en backup.js |
| C3: loadDB NaN | Sanitiza `total`/`pagado` si no son números finitos |
| I3: Snapshot path | Scheduler recibe `dataDir`/`uploadsDir` desde server.js |
| I5: Rate limiting | 20 uploads/min por IP |
| I6: PDFs huérfanos | Cleanup diario en scheduler |
| M4: MARGIN_PCT | Margen configurable via env var (default 40%) |
| package.json | dotenv + `npm run check` |

### Commit `27dae0c` — KPI overflow fix
- `.kpiValue`: `clamp(13px, 4vw, 26px)` — números como `$1,208,565` no desbordan en móvil

---

## Próximos pasos

1. **Push a GitHub (Antigravity):** `git push origin main` — commits pendientes: `ed794ac`, `27dae0c`
2. **Verificar en producción:** "Ver quién falta", cuadrito rojo, KPIs en iPhone

---

## Arquitectura de archivos clave

```
server.js               ← Express app + rutas + Closing Control (diferente a backend)
utils/
  persistence.js        ← Atomic writes (sin getMexicoTimestamp — diferencia con backend)
  scheduler.js          ← Cron jobs: backup + snapshot + cleanup huérfanos
scripts/
  backup.js             ← Backup a R2 con dry-run mode (spawnSync seguro)
data/
  notas.json            ← Base de datos principal (Persistent Disk)
  closing.json          ← Estado del timer de cierre mensual
uploads/                ← Evidencias subidas
public/                 ← Frontend estático
```

---

## Diferencias clave vs backend

| Aspecto | Backend | Mars |
|---------|---------|------|
| Batch | Martes 00:00 | Martes 00:00 |
| Reporte | `/reporte` HTML server-side | PDF client-side (jsPDF) via Closing Control |
| Pagos | Sin método | Con método (efectivo/tarjeta/transferencia) + comisión 4.06% |
| Eliminación | Sin delete | Con delete modal |
| KPIs | 6 cards | 6 cards (incluye Comisiones bancarias) |
| VIP | Server-side | Client-side |

---

## Variables de entorno relevantes

| Variable | Obligatoria | Efecto |
|----------|-------------|--------|
| DATA_DIR | Sí (Render) | Ruta del disco persistente |
| SYSTEM_NAME | Sí | Namespace en R2 (usar `avyna-mars`) |
| R2_ENDPOINT | Sí | Backup destino |
| ADMIN_USER | Opcional | Activa auth HTTP Basic |
| ADMIN_PASS | Opcional | Activa auth HTTP Basic |
| MARGIN_PCT | Opcional | Margen de utilidad (default 40%) |
| RESEND_API_KEY | Opcional* | Habilita alerta email inmediata al clasificar bonif/repo o borrar una nota. Sin ella, sigue funcionando pero NO avisa (solo warning en log). |
| ALERT_EMAIL_FROM | Opcional* | Remitente — debe ser dominio verificado en Resend. |
| ALERT_EMAIL_TO | Opcional | Destino de la alerta (default `ernesto.velez.gtz@gmail.com`). |

\* 2026-07-10: clasificación de notas, soft-delete y liquidación diferida de bonificaciones ya en producción, pendiente activar la alerta por email en Render → Environment.

---

## Decisiones inamovibles

- Mismo patrón de persistencia que backend (Persistent Disk + R2).
- Backend fue la base. Mantener paridad con backend y operado.
- Push siempre desde Antigravity (credenciales Avyna, no LDS).
