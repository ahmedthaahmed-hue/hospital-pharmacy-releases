// Roles and permissions. Every user has one role; a role is a set of permissions from PERMISSIONS. The roles live in
// the `roles` table (migration 0006-roles): five built in (BUILTIN_ROLES, their permissions changeable except the
// owner's) and any number made by the owner. Only the OWNER — the system's owner, the account made in the setup
// wizard — creates, changes and deletes roles, gives the owner role, sees the licence and the system notifications.
// users.role keeps a coarse level (admin / pharmacist / viewer) derived from the role's permissions (levelFor): the
// old checks that only distinguish "can change things" and "is an administrator" keep working on it.
export const PERMISSION_GROUPS = [
    { key: "work", label: "Daily work" },
    { key: "pharmacy", label: "Pharmacy management" },
    { key: "admin", label: "Administration" },
];
export const PERMISSIONS = [
    { key: "dispense", group: "work", label: "Dispense and return medicine", hint: "Ward dispensing, manual dispenses and returns" },
    { key: "runs", group: "work", label: "Run the daily run", hint: "Dispense and print the doses of the medical day" },
    { key: "orders", group: "work", label: "Write and change patients' orders", hint: "Also loads order templates and operation kits onto a patient" },
    { key: "walkin", group: "work", label: "Walk-in prescriptions" },
    { key: "patients", group: "work", label: "Add, edit, discharge and restore patients" },
    { key: "alerts", group: "work", label: "See stock alerts", hint: "The alerts bell and the stock badge in the menu" },
    { key: "stock.receive", group: "pharmacy", label: "Receive stock" },
    { key: "stock.adjust", group: "pharmacy", label: "Stock counts, adjustments and TEMP stock" },
    { key: "stock.transfer", group: "pharmacy", label: "Request, send and receive stock between pharmacies", hint: "Also the minimum and maximum levels" },
    { key: "stock.purchase", group: "pharmacy", label: "Suppliers, purchase orders and returns to suppliers", hint: "Also prices and stock value" },
    { key: "other_pharmacies", group: "pharmacy", label: "See other pharmacies' patients and stock" },
    { key: "items", group: "pharmacy", label: "Edit the item catalogue" },
    { key: "templates", group: "pharmacy", label: "Edit Rx and order templates" },
    { key: "operations", group: "pharmacy", label: "Edit operations and their kits" },
    { key: "reports", group: "pharmacy", label: "See reports" },
    { key: "analytics", group: "pharmacy", label: "See analytics" },
    { key: "safety.rules", group: "pharmacy", label: "Maintain clinical safety rules", hint: "Interaction rules, high-alert and look-alike flags, dose limits" },
    { key: "pharmacies.all", group: "admin", label: "Work in any pharmacy", hint: "Switch pharmacy, and reports, analytics and stock of every pharmacy" },
    { key: "admin.users", group: "admin", label: "Manage user accounts", hint: "Only roles with no more permissions than their own; never the owner" },
    { key: "admin.pharmacies", group: "admin", label: "Pharmacies, departments and lookups" },
    { key: "admin.settings", group: "admin", label: "Change the settings" },
    { key: "admin.labels", group: "admin", label: "Change the label designs" },
    { key: "layouts.shared", group: "admin", label: "Save screen layouts for a PC, a pharmacy or everyone" },
    { key: "admin.backups", group: "admin", label: "Backups and restoring the database" },
    { key: "admin.network", group: "admin", label: "Pharmacy PCs and the recovery key" },
    { key: "admin.updates", group: "admin", label: "Install updates" },
    { key: "admin.audit", group: "admin", label: "Audit log and system information" },
];
export const PERMISSION_KEYS = new Set(PERMISSIONS.map((p) => p.key));
/** What only the owner can do, whatever the roles say (shown in the role editor). */
export const OWNER_ONLY = ["Create, change and delete roles", "Give or take the owner role", "The machine licence", "System notifications (licence and updates)"];
const WORK = ["dispense", "runs", "orders", "walkin", "patients"];
const SENIOR = [...WORK, "stock.receive", "stock.adjust", "stock.transfer", "stock.purchase", "other_pharmacies", "items", "templates", "operations", "reports", "analytics",
    "safety.rules"];
const MANAGER = [...SENIOR, "pharmacies.all", "admin.users", "admin.pharmacies", "admin.settings", "admin.labels", "layouts.shared",
    "admin.backups", "admin.network", "admin.audit"];
/** The built-in roles, highest first. Stock alerts and updates start with the owner only. */
export const BUILTIN_ROLES = [
    { key: "owner", name: "Owner", description: "The system's owner: everything, and the only one who manages roles and sees the licence",
        permissions: PERMISSIONS.map((p) => p.key) },
    { key: "manager", name: "Pharmacy manager", description: "Runs the pharmacies: staff accounts, settings, backups, every pharmacy", permissions: MANAGER },
    { key: "senior", name: "Senior pharmacist", description: "Daily work plus stock counts, the catalogue, templates, operations and analytics", permissions: SENIOR },
    { key: "pharmacist", name: "Pharmacist", description: "Daily work: ward dispensing, the daily run, walk-ins, patients, receiving stock",
        permissions: [...WORK, "stock.receive", "stock.transfer", "reports"] },
    { key: "viewer", name: "Viewer", description: "Can look at everything in their pharmacy, change nothing", permissions: ["reports", "analytics"] },
];
/**
 * The built-in role a user without a role (data written before roles existed) is treated as, by their level: what
 * they could do before. A NEW account given an old level name gets NEW_ACCOUNT_ROLE instead.
 */
export const LEGACY_ROLE = { admin: "manager", pharmacist: "senior", viewer: "viewer" };
export const NEW_ACCOUNT_ROLE = { admin: "manager", pharmacist: "pharmacist", viewer: "viewer" };
const WRITES = new Set(["dispense", "runs", "orders", "walkin", "patients", "stock.receive", "stock.adjust", "stock.transfer", "stock.purchase", "items", "templates", "operations",
    "safety.rules"]);
/** The coarse level kept in users.role: admin (any administration), pharmacist (changes anything), or viewer. */
export function levelFor(perms) {
    const list = [...perms];
    if (list.some((p) => p.startsWith("admin.") || p === "pharmacies.all" || p === "layouts.shared"))
        return "admin";
    if (list.some((p) => WRITES.has(p)))
        return "pharmacist";
    return "viewer";
}
/** A role's permissions, as stored (JSON), keeping only the ones that exist. */
export function parsePerms(json) {
    try {
        const a = JSON.parse(json ?? "[]");
        return Array.isArray(a) ? a.filter((p) => typeof p === "string" && PERMISSION_KEYS.has(p)) : [];
    }
    catch {
        return [];
    }
}
