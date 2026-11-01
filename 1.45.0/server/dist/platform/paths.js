// Where this PC keeps its files. Everything lives in the data folder next to the database (DB_FILE), so moving or
// backing up a PC means moving one folder.
import { dirname, join, resolve } from "node:path";
export const dbFile = () => resolve(process.env.DB_FILE ?? "data/pharmacy.sqlite");
export const dataDir = () => dirname(dbFile());
export const dataPath = (...p) => join(dataDir(), ...p);
/** The install root (the folder with server/ and web/); the launcher sets APP_ROOT, development uses the repo. */
export const appRoot = () => resolve(process.env.APP_ROOT ?? join(process.cwd(), ".."));
