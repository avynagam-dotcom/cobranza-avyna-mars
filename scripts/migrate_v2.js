const fs = require('fs');
const path = require('path');

// Configuration
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
const DB_FILE = path.join(DATA_DIR, 'notas.json');

console.log(`[Migration] Target DB: ${DB_FILE}`);

if (!fs.existsSync(DB_FILE)) {
    console.error('[Migration] Error: DB file not found.');
    process.exit(1);
}

// Load Data
const raw = fs.readFileSync(DB_FILE, 'utf8');
let notas = JSON.parse(raw);

if (!Array.isArray(notas)) {
    console.error('[Migration] Error: Invalid DB format (not an array).');
    process.exit(1);
}

console.log(`[Migration] Loaded ${notas.length} records.`);

let modifiedCount = 0;
let totalBalanceBefore = 0;
let totalBalanceAfter = 0;

// Calculate initial balance for verification
notas.forEach(n => {
    totalBalanceBefore += (n.pagado || 0);
});

// Migration Logic
notas = notas.map(n => {
    const originalPagado = n.pagado || 0;

    // Ensure pagos array exists
    if (!n.pagos || !Array.isArray(n.pagos)) {
        n.pagos = [];
    }

    // Check if we need to migrate 'pagado' to 'pagos'
    // Condition: pagado > 0 AND pagos is empty
    if (originalPagado > 0 && n.pagos.length === 0) {
        console.log(`[Migrating] ID: ${n.id} | Client: ${n.cliente || 'Unknown'} | Amount: ${originalPagado}`);

        n.pagos.push({
            monto: originalPagado,
            metodo: 'efectivo', // Assume cash for legacy
            comision: 0,
            fecha: n.firstPaymentAt || n.uploadedAt || new Date().toISOString(),
            isLegacy: true,
            note: 'Migración V2 (Saldo acumulado anterior)'
        });

        modifiedCount++;
    }

    // Re-verify integrity: sum of pagos should equal pagado field
    // We will KEEP 'pagado' field as a cache, but it must be consistent.
    const sumPagos = n.pagos.reduce((sum, p) => sum + (p.monto || 0), 0);

    // Auto-fix consistency if slightly off (though logic above ensures exact match for new migrations)
    if (Math.abs(sumPagos - (n.pagado || 0)) > 0.01) {
        console.warn(`[Warning] ID: ${n.id} mismatch. Pagado: ${n.pagado}, Sum: ${sumPagos}. Updating 'pagado' to match sum.`);
        n.pagado = sumPagos;
    }

    return n;
});

// Calculate final balance
notas.forEach(n => {
    totalBalanceAfter += (n.pagado || 0);
});

console.log('-----------------------------------');
console.log(`[Migration] Records Modified: ${modifiedCount}`);
console.log(`[Migration] Balance Before: $${totalBalanceBefore.toFixed(2)}`);
console.log(`[Migration] Balance After:  $${totalBalanceAfter.toFixed(2)}`);

if (Math.abs(totalBalanceAfter - totalBalanceBefore) < 0.01) {
    console.log('[Migration] ✅ SUCCESS: Balance Check OK.');

    // Save
    fs.writeFileSync(DB_FILE, JSON.stringify(notas, null, 2));
    console.log('[Migration] Database updated successfully.');
} else {
    console.error('[Migration] ❌ CRITICAL: Balance mismatch! Aborting save.');
    process.exit(1);
}
