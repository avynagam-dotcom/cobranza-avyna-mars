"use strict";

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

async function runBackup() {
    const SYSTEM_NAME = process.env.SYSTEM_NAME || "avyna-desconocido";
    const R2_ENDPOINT = process.env.R2_ENDPOINT;
    const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
    const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
    const R2_BUCKET = process.env.R2_BUCKET;

    // Carpeta de datos a respaldar: Preferimos process.env.DATA_DIR si está seteado (por server.js)
    // O fallback a la lógica de detección
    const DISK_PATH = "/var/data/cobranza";
    let SOURCE_DIR_DATA = process.env.DATA_DIR;
    let SOURCE_DIR_UPLOADS = process.env.UPLOADS_DIR;

    if (!SOURCE_DIR_DATA) {
        // Fallback manual si se corre standalone sin las vars
        if (fs.existsSync(DISK_PATH)) {
            SOURCE_DIR_DATA = path.join(DISK_PATH, "data");
            SOURCE_DIR_UPLOADS = path.join(DISK_PATH, "uploads");
        } else {
            SOURCE_DIR_DATA = path.join(__dirname, "../data");
            SOURCE_DIR_UPLOADS = path.join(__dirname, "../uploads");
        }
    }

    if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
        throw new Error("Faltan variables de entorno para el backup (R2)");
    }

    const date = new Date().toISOString().split("T")[0];
    const filename = `backup-${SYSTEM_NAME}-${date}.tar.gz`;
    const archivePath = path.join("/tmp", filename);

    try {
        console.log(`📦 Creando archivo comprimido: ${filename}...`);

        // Estrategia: tar de los contenidos, pero es tricky si están en rutas separadas.
        // Simplificación: Vamos a hacer cd a la raiz común o añadirlos por ruta absoluta pero transformando nombres
        // Mejor: copiamos lo que queremos backupear a una carpeta temp de staging? No, muy lento.
        // Usamos rutas absolutas en tar.

        const pathsToBackup = [];
        if (fs.existsSync(SOURCE_DIR_DATA)) pathsToBackup.push(SOURCE_DIR_DATA);
        if (fs.existsSync(SOURCE_DIR_UPLOADS)) pathsToBackup.push(SOURCE_DIR_UPLOADS);

        if (pathsToBackup.length === 0) {
            console.log("⚠️ No hay carpetas de datos válidas para respaldar.");
            return;
        }

        // Usamos -P para rutas absolutas o nos movemos? 
        // Mejor: Nos aseguramos de guardar la estructura relativa si es posible, o simplemente guardar flat.
        // Para consistencia con restauración, guardaremos con estructura de "data" y "uploads" 
        // asumiendo que el restore las espera.
        // TRUCO: tar -czf archivo.tar.gz -C /path/to/parent data -C /path/to/other/parent uploads

        // Dado que DATA_DIR y UPLOADS_DIR suelen ser hermanos, podemos intentar eso. 
        // Si no, lo hacemos simple: tar de los paths absolutos.

        const cmdParts = [`tar -czf ${archivePath}`];

        if (fs.existsSync(SOURCE_DIR_DATA)) {
            const parent = path.dirname(SOURCE_DIR_DATA);
            const base = path.basename(SOURCE_DIR_DATA);
            cmdParts.push(`-C "${parent}" "${base}"`);
        }
        if (fs.existsSync(SOURCE_DIR_UPLOADS)) {
            const parent = path.dirname(SOURCE_DIR_UPLOADS);
            const base = path.basename(SOURCE_DIR_UPLOADS);
            cmdParts.push(`-C "${parent}" "${base}"`);
        }

        execSync(cmdParts.join(" "));

        console.log(`🚀 Subiendo a Cloudflare R2...`);
        const s3 = new S3Client({
            region: "auto",
            endpoint: R2_ENDPOINT,
            credentials: {
                accessKeyId: R2_ACCESS_KEY_ID,
                secretAccessKey: R2_SECRET_ACCESS_KEY,
            },
        });

        const fileBuffer = fs.readFileSync(archivePath);
        await s3.send(new PutObjectCommand({
            Bucket: R2_BUCKET,
            Key: `mars/${filename}`, // ✅ Prefijo mars/ forzado como solicitado
            Body: fileBuffer,
            ContentType: "application/gzip",
        }));

        console.log(`✅ Backup completado exitosamente: ${SYSTEM_NAME}/${filename}`);

        // Limpieza
        fs.unlinkSync(archivePath);

    } catch (error) {
        console.error("❌ Error durante el backup:", error);
        throw error;
    }
}

module.exports = runBackup;

if (require.main === module) {
    runBackup().catch(() => process.exit(1));
}
