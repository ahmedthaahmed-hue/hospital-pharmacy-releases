/** Idempotent seed of fixed lookup rows the code depends on. */
export function seedBase(db) {
    const orderTypes = [
        ["regular", "منتظم", 1, 1],
        ["cont_drip", "وريد مستمر", 0, 2],
        ["once", "مرة واحدة", 0, 3],
        ["care", "رعاية", 0, 4],
        ["operation", "عملية", 0, 5],
    ];
    for (const [code, name, isReg, sort] of orderTypes)
        db.run("INSERT OR IGNORE INTO order_types(code,name,is_regular,sort) VALUES (?,?,?,?)", [code, name, isReg, sort]);
    const dispenseTypes = [
        ["run_24h", "صرف 24 ساعة", "24h Auto"],
        ["selected_times", "صرف مواعيد محددة", "Selected Times"],
        ["midday", "صرف منتصف اليوم", "Mid-day print-dispense"],
        ["drip", "صرف محلول مستمر", "Drip print-dispense"],
        ["manual", "صرف يدوي", "Manual item dispense"],
        ["walkin", "صرف روشتة خارجية", "Walk-in dispense"],
        ["return", "مرتجع", "Returned"],
    ];
    for (const [code, name, legacy] of dispenseTypes)
        db.run("INSERT OR IGNORE INTO dispense_types(code,name,legacy_name) VALUES (?,?,?)", [code, name, legacy]);
    db.run("INSERT OR IGNORE INTO chat_rooms(id,name) VALUES (1,'عام')");
    const defaults = {
        "label.width_mm": "55",
        "label.height_mm": "55",
        "schedule.day_start": "06:00",
        "schedule.grace_hours": "3",
        "backup.dir": "backups",
        "backup.keep_days": "30",
        "hospital.name": "مستشفى",
    };
    for (const [k, v] of Object.entries(defaults))
        db.run("INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)", [k, v]);
}
