# project_state.md — cobranza-avyna-mars
> Creado: 2026-05-01 (paridad con backend) | Última actualización: 2026-07-10

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
