// The error the API answers with (lib/http.ts re-exports it). On its own so code that runs without the database — the
// owner's standalone phone relay (relay-main.ts) — can use it.
/** Error with an HTTP status and a user-facing (English) message. */
export class HttpError extends Error {
    status;
    details;
    constructor(status, message, details) {
        super(message);
        this.status = status;
        this.details = details;
    }
}
