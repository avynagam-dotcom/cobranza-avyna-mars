const fs = require('fs');
const path = require('path');

// Ensure we know where the data directory is
// This relies on server.js setting process.env.DATA_DIR before using this module
// or we will fallback to a safe default if not set (though server.js should set it)
const getDataDir = () => process.env.DATA_DIR || path.join(__dirname, '../data');

function appendAuditLog(action, details) {
    try {
        const dataDir = getDataDir();
        const auditFile = path.join(dataDir, 'audit.jsonl');

        const entry = {
            timestamp: new Date().toISOString(),
            action,
            details
        };

        fs.appendFileSync(auditFile, JSON.stringify(entry) + '\n');
    } catch (err) {
        console.error('[Persistence] Audit Log Error:', err.message);
    }
}

/**
 * Atomic write implementation.
 * 1. Write to .tmp file
 * 2. Verify file size > 0
 * 3. fs.renameSync to replace target
 * 
 * @param {string} filename - Name of file (or relative path)
 * @param {string|Buffer} data - Content to write
 * @param {string} [baseDir] - Optional base directory. Defaults to process.env.DATA_DIR.
 */
function saveData(filename, data, baseDir = null) {
    try {
        const rootDir = baseDir || getDataDir();

        // Ensure directory exists
        if (!fs.existsSync(rootDir)) {
            fs.mkdirSync(rootDir, { recursive: true });
        }

        const targetPath = path.join(rootDir, filename);
        const tempPath = `${targetPath}.tmp`;

        // 1. Write to .tmp
        fs.writeFileSync(tempPath, data);

        // 2. Validate integrity
        const stats = fs.statSync(tempPath);
        if (stats.size === 0) {
            throw new Error(`Write verification failed: ${tempPath} is empty.`);
        }

        // 3. Atomic replacement
        fs.renameSync(tempPath, targetPath);

        // Audit success
        appendAuditLog('SAVE_SUCCESS', { file: filename, size: stats.size });
        console.log(`[Persistence] Saved ${filename} (${stats.size} bytes)`);

        return true;
    } catch (err) {
        console.error(`[Persistence] SAVE FAILED for ${filename}:`, err.message);
        appendAuditLog('SAVE_ERROR', { file: filename, error: err.message });
        throw err; // Propagate error so server knows it failed
    }
}

/**
 * Auditoría de NEGOCIO (clasificación de notas, borrados) — separada del
 * audit.jsonl técnico de appendAuditLog (que solo audita guardado atómico).
 */
function appendBusinessAuditLog(action, details) {
    try {
        const dataDir = getDataDir();
        const auditFile = path.join(dataDir, 'business-audit.jsonl');

        const entry = {
            timestamp: new Date().toISOString(),
            action,
            ...details,
        };

        fs.appendFileSync(auditFile, JSON.stringify(entry) + '\n');
    } catch (err) {
        console.error('[Persistence] Business Audit Log Error:', err.message);
    }
}

module.exports = { saveData, appendBusinessAuditLog };
