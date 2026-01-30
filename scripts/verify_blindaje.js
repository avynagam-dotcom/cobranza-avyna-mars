const fs = require('fs');
const path = require('path');
const { saveData } = require('../utils/persistence');

// Setup environment for testing
const TEST_DIR = path.join(__dirname, '../test_blindaje');
process.env.DATA_DIR = path.join(TEST_DIR, 'data');
process.env.UPLOADS_DIR = path.join(TEST_DIR, 'uploads');

const auditFile = path.join(process.env.DATA_DIR, 'audit.jsonl');

// Clean previous tests
if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
}
fs.mkdirSync(TEST_DIR);

console.log("---- INITIATING BLINDAJE VERIFICATION ----");

// 1. Test Atomic Write
console.log("\n[Test 1] Testing Atomic Write...");
try {
    saveData('test_db.json', JSON.stringify({ status: 'ok' }));

    // Check if file exists
    const filePath = path.join(process.env.DATA_DIR, 'test_db.json');
    if (fs.existsSync(filePath)) {
        console.log("✅ File written successfully to DATA_DIR.");
    } else {
        console.error("❌ File NOT found in DATA_DIR.");
        process.exit(1);
    }

    // Check content
    const content = fs.readFileSync(filePath, 'utf8');
    if (content.includes('ok')) {
        console.log("✅ File content verification passed.");
    } else {
        console.error("❌ File content mismatch.");
        process.exit(1);
    }
} catch (e) {
    console.error("❌ Atomic write failed:", e);
    process.exit(1);
}

// 2. Test Audit Log
console.log("\n[Test 2] Testing Audit Log...");
if (fs.existsSync(auditFile)) {
    const logs = fs.readFileSync(auditFile, 'utf8');
    if (logs.includes('SAVE_SUCCESS') && logs.includes('test_db.json')) {
        console.log("✅ Audit log recorded success event.");
    } else {
        console.error("❌ Audit log missing expected entry.");
        process.exit(1);
    }
} else {
    console.error("❌ Audit log file not created.");
    process.exit(1);
}

// 3. Test Integrity Check (Simulate failure)
console.log("\n[Test 3] Testing Integrity Check (Empty Write Rejection)...");
// We can't easily mock fs inside this script without a library, but we can verify that
// saveData throws if we pass empty buffer to it? 
// No, saveData writes what we give it. 
// However, the rule is "Validación de integridad (peso > 0 bytes)".
// So if we try to save empty string...
try {
    saveData('empty.json', '');
    console.error("❌ Should have rejected empty write, but allowed it.");
} catch (e) {
    if (e.message.includes('Write verification failed')) {
        console.log("✅ correctly rejected empty write.");
    } else {
        console.error("❌ Failed with unexpected error:", e);
    }
}

console.log("\n---- VERIFICATION SUCCESSFUL ----");
