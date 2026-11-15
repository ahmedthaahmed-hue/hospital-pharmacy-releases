// Checks of folder paths an admin types in (Settings → Backups): pure, so the settings registry can use them too.
/** Folders a backup copy must never go to (the system's own); a drive or share root, or any other folder, is fine. */
const SYSTEM_DIR = /^(?:[A-Za-z]:[\\/]+(?:windows|program files(?: \(x86\))?|programdata|users[\\/]+[^\\/]+[\\/]+appdata)(?:[\\/]|$)|\/(?:$|(?:bin|boot|dev|etc|lib|lib64|proc|sbin|sys|usr|var\/lib)(?:\/|$)))/i;
/** Why this "also copy to" folder cannot be used, or null when it can (also checked when the setting is saved). */
export function copyDirProblem(v) {
    const p = v.trim();
    if (!p)
        return null;
    if (!/^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\/)/.test(p))
        return "Give the full path, e.g. E:\\PharmacyBackups or \\\\PC-NAME\\Backups";
    if (SYSTEM_DIR.test(p))
        return "Not a system folder: choose a backup disk or a shared folder";
    return null;
}
