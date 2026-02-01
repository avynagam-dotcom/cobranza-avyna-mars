"use strict";

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

async function runBackup() {
    console.log("[Backup] 🛡️ Iniciando protocolo de blindaje de datos...");

    const SYSTEM_NAME = process.env.SYSTEM_NAME || "avyna-mars";
    const R2_ENDPOINT = process.env.R2_ENDPOINT;
    const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
    const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
    const R2_BUCKET = process.env.R2_BUCKET;

    // LA VERDAD ABSOLUTA O NADA
    // En el ecosistema blindado, server.js define DATA_DIR y UPLOADS_DIR en el environment.
    const DATA_DIR = process.env.DATA_DIR;
    const UPLOADS_DIR = process.env.UPLOADS_DIR;

    if (!DATA_DIR) {
        console.error("❌ [Backup] ABORT: process.env.DATA_DIR no definido. El blindaje requiere rutas explícitas.");
        return;
    }

    if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_BUCKET) {
        console.error("❌ [Backup] ABORT: Credenciales R2 incompletas.");
        return;
    }

    const date = new Date().toISOString().split("T")[0];
    const filename = `backup-${SYSTEM_NAME}-${date}.tar.gz`;
    const tempFilePath = path.join("/tmp", filename);

    try {
        // 1. Validar existencia
        if (!fs.existsSync(DATA_DIR)) {
            console.warn(`[Backup] ⚠️ DATA_DIR no existe física: ${DATA_DIR}. Nada que respaldar.`);
            return;
        }

        console.log(`[Backup] 📦 Comprimiendo origen: ${DATA_DIR}...`);

        // 2. Compresión Inteligente
        // Usamos path relativo (-C) para no guardar rutas absolutas extrañas en el tar
        const parentDir = path.dirname(DATA_DIR);
        const folderName = path.basename(DATA_DIR);

        // Incluimos uploads si está dentro o hermano, pero para simplificar el blindaje:
        // Respaldamos TODO el DATA_DIR, que debería contener 'uploads' si es la estructura estándar.
        // Si uploads es externo, lo añadimos.

        let cmd = `tar -czf "${tempFilePath}" -C "${parentDir}" "${folderName}"`;

        // Si UPLOADS_DIR existe y NO está dentro de DATA_DIR, lo agregamos
        if (UPLOADS_DIR && fs.existsSync(UPLOADS_DIR) && !UPLOADS_DIR.startsWith(DATA_DIR)) {
            const upParent = path.dirname(UPLOADS_DIR);
            const upName = path.basename(UPLOADS_DIR);
            console.log(`[Backup] ➕ Incluyendo adjuntos externos: ${UPLOADS_DIR}`);
            cmd += ` -C "${upParent}" "${upName}"`;
        }

        execSync(cmd);
        const size = fs.statSync(tempFilePath).size;
        console.log(`[Backup] 📦 Archivo generado: ${filename} (${(size / 1024 / 1024).toFixed(2)} MB)`);

        // 3. Upload R2
        console.log(`[Backup] 🚀 Subiendo a R2 (${R2_BUCKET})...`);
        const s3 = new S3Client({
            region: "auto",
            endpoint: R2_ENDPOINT,
            credentials: {
                accessKeyId: R2_ACCESS_KEY_ID,
                secretAccessKey: R2_SECRET_ACCESS_KEY,
            },
        });

        const fileBuffer = fs.readFileSync(tempFilePath);
        await s3.send(new PutObjectCommand({
            Bucket: R2_BUCKET,
            Key: `mars/${filename}`, // Namespace reforzado
            Body: fileBuffer,
            ContentType: "application/gzip",
        }));

        console.log(`[Backup] ✅ BLINDAJE COMPLETADO: ${filename}`);

        // 4. Cleanup
        fs.unlinkSync(tempFilePath);

    } catch (error) {
        console.error("❌ [Backup] FALLO CRÍTICO:", error);
        // No throw para no tumbar el proceso si es un cron, pero logueamos fuerte.
    }
}

module.exports = runBackup;

if (require.main === module) {
    runBackup().catch(console.error);
}
