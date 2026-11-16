// The labels' font (release 1.52, docs/LAYOUTS.md → The label font). Hacen Eltaroute Text is licensed to the hospital
// and never shipped with the app. Until 1.51 it had to be copied by hand into web\dist\fonts on every PC (or found among
// the PC's installed fonts by the installer), and an update replaced that folder. Now an admin uploads it once on the
// main server (Admin → Labels): it is kept in the data folder, which updates do not touch, served at the address the
// labels ask for, and each pharmacy PC fetches it from the main server over its sync connection.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appRoot, dataPath } from "./paths.js";
export const FONT_NAME = "Hacen-Eltaroute-Text.ttf";
export const FONT_URL = `/fonts/${FONT_NAME}`;
export const uploadedFont = () => dataPath("fonts", FONT_NAME);
/** Where the installer puts a copy found among the PC's installed fonts (deploy/setup-pc.ps1). */
export const installedFont = () => join(appRoot(), "web", "dist", "fonts", FONT_NAME);
/** The font file this PC uses for labels, if it has one: the uploaded one first. */
export function labelFontFile() {
    if (existsSync(uploadedFont()))
        return { file: uploadedFont(), source: "uploaded" };
    if (existsSync(installedFont()))
        return { file: installedFont(), source: "installed" };
    return null;
}
export function labelFontStatus() {
    const f = labelFontFile();
    return { present: !!f, source: f?.source ?? null, bytes: f ? statSync(f.file).size : null };
}
/** A TrueType or OpenType font (its first four bytes), of a sensible size. */
export function isFont(buf) {
    if (buf.length < 1024 || buf.length > 20 * 1024 * 1024)
        return false;
    const tag = buf.subarray(0, 4);
    return tag.equals(Buffer.from([0, 1, 0, 0])) || ["OTTO", "true", "ttcf"].includes(tag.toString("latin1"));
}
export function saveLabelFont(buf) {
    if (!isFont(buf))
        throw new Error("This is not a font file (.ttf or .otf)");
    mkdirSync(dirname(uploadedFont()), { recursive: true });
    writeFileSync(uploadedFont(), buf);
}
export function removeLabelFont() { rmSync(uploadedFont(), { force: true }); }
export const readLabelFont = () => { const f = labelFontFile(); return f ? readFileSync(f.file) : null; };
