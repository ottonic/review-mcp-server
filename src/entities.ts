/**
 * Entity IDs, and how this server stores and matches them.
 *
 * An entity ID is opaque here: it belongs to the producer's ID scheme and to one
 * artifact revision, and it means nothing outside those. Two things follow, and
 * both live in this module so no caller can get them subtly wrong — how a set of
 * IDs is persisted, and how a single ID is matched against a persisted set.
 */

/**
 * SQL predicate matching one entity ID in a stored JSON array column.
 *
 * The dependency does the work here: SQLite's JSON functions are built in, so
 * membership is an exact test against the parsed array. Matching on the array's text
 * instead is how a query about `face:3` also quietly answers about `face:30`.
 * @param column - the JSON array column to test, as a qualified name such as
 * `reviews.entity_ids`. Callers pass a literal from this codebase, never caller input.
 * @returns a predicate taking the entity ID as its bound parameter.
 */
export function entityIdPredicate(column: string): string {
  return `EXISTS (SELECT 1 FROM json_each(${column}) WHERE value = ?)`;
}

/**
 * Persist a set of entity IDs.
 *
 * A set, because two basis items may name the same face, and a repeated ID makes a
 * record look like it covers more geometry than it does.
 * @param ids - entity IDs in first-seen order.
 * @returns the JSON array to store.
 */
export function encodeEntityIds(ids: readonly string[]): string {
  return JSON.stringify([...new Set(ids)]);
}

/**
 * Every entity named by items that carry `faces`.
 * @param items - basis items, or anything else that names faces.
 * @returns entity IDs in first-seen order, deduplicated.
 */
export function entityIdsOf(items: readonly { readonly faces: readonly string[] }[]): string[] {
  return [...new Set(items.flatMap((item) => item.faces))];
}
