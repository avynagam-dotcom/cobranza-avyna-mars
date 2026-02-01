"use strict";

const cron = require("node-cron");
const runBackup = require("../scripts/backup");

function initScheduler() {
    console.log("[Scheduler] 🕒 Inicializando cron jobs...");

    // Backup automático a las 09:00 UTC todos los días
    // 0 9 * * *
    cron.schedule("0 9 * * *", async () => {
        console.log("[Scheduler] 🛡️ Ejecutando backup blindado (09:00 UTC)...");
        try {
            await runBackup();
        } catch (err) {
            console.error("[Scheduler] ❌ Error crítico en backup:", err);
        }
    });

    console.log("[Scheduler] ✅ Jobs programados correctamente (Next: 09:00 UTC)");
}

module.exports = { initScheduler };
