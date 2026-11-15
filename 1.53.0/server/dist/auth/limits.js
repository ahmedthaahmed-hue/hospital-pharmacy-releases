// Limits on guessing the short secrets (release 1.8): a PIN is 4–8 digits and a second-step code 6, so besides the
// sign-in limits by address (lib/rate-limit.ts, in memory) each account counts its own wrong tries, kept in the database.
/** Wrong PINs in a row before the PIN is turned off (the password is needed, and a new PIN). */
export const PIN_TRIES = 5;
/** Wrong second-step codes in a row before codes are refused for a while. */
export const CODE_TRIES = 5;
export const CODE_LOCK_MINUTES = 15;
