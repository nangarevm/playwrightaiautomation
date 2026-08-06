import Database from "better-sqlite3";
const dbPath = "C:\\Users\\Vivek\\Desktop\\AIProd\\test-automation-platform\\server\\platform.db";
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = OFF");

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
  .all()
  .map((r) => r.name);

console.log("Tables found:", tables);

const wipe = db.transaction(() => {
  for (const t of tables) {
    const before = db.prepare(`SELECT COUNT(*) as c FROM "${t}"`).get().c;
    db.prepare(`DELETE FROM "${t}"`).run();
    console.log(`  ${t}: deleted ${before} row(s)`);
  }
});
wipe();

// Reclaim disk space and reset autoincrement counters if any.
db.exec("VACUUM");

const remaining = tables.map((t) => ({ t, c: db.prepare(`SELECT COUNT(*) as c FROM "${t}"`).get().c }));
console.log("Post-wipe row counts:", remaining);
db.close();
console.log("Done.");
