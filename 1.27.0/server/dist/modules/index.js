import lookups from "./lookups/routes.js";
import patients from "./patients/routes.js";
import orders from "./orders/routes.js";
import items from "./items/routes.js";
import stock from "./stock/routes.js";
import dispense from "./dispense/routes.js";
import runs from "./runs/routes.js";
import reports from "./reports/routes.js";
import walkin from "./walkin/routes.js";
import rxTemplates from "./rx-templates/routes.js";
import orderTemplates from "./order-templates/routes.js";
import operations from "./operations/routes.js";
import chat from "./chat/routes.js";
import admin from "./admin/routes.js";
import analytics from "./analytics/routes.js";
import layouts from "./layouts/routes.js";
import safety from "./safety/routes.js";
import barcodes from "./barcodes/routes.js";
import transfers from "./transfers/routes.js";
import purchasing from "./purchasing/routes.js";
import records from "./records/routes.js";
import clinical from "./clinical/routes.js";
import fleet from "./fleet/routes.js";
import his from "./his/routes.js";
import ai from "./ai/routes.js";
import print from "./print/routes.js";
export const modules = [
    ["lookups", lookups],
    ["patients", patients],
    ["orders", orders],
    ["items", items],
    ["stock", stock],
    ["dispense", dispense],
    ["runs", runs],
    ["reports", reports],
    ["walkin", walkin],
    ["rx-templates", rxTemplates],
    ["order-templates", orderTemplates],
    ["operations", operations],
    ["chat", chat],
    ["admin", admin],
    ["fleet", fleet],
    ["his", his],
    ["ai", ai],
    ["analytics", analytics],
    ["layouts", layouts],
    ["safety", safety],
    ["barcodes", barcodes],
    ["transfers", transfers],
    ["purchasing", purchasing],
    ["records", records],
    ["clinical", clinical],
    ["print", print],
];
