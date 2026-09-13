import type { db } from "./index";

/**
 * The database handle passed through the service layer.
 *
 * Declared as the type of the real client so production code is exact, while
 * tests can substitute a PGlite-backed instance via a cast.
 */
export type Db = typeof db;
