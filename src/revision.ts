import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Revision-aware identity helpers. The cad-viewer treats a bare entity id like
// "face:12" as ambiguous across file revisions; it resolves identity via a
// content hash (revision) plus a typed subject reference (see
// ENGINEERING_INTELLIGENCE_CONTRACT.md).

/**
 * Compute the sha256 content hash of a STEP file. Returns "unknown" if the file
 * cannot be read (so callers can still record intent without failing).
 */
export function fileRevision(filePath: string): string {
  try {
    const resolved = resolve(filePath);
    if (!existsSync(resolved)) return "unknown";
    const data = readFileSync(resolved);
    return "sha256:" + createHash("sha256").update(data).digest("hex");
  } catch {
    return "unknown";
  }
}

/**
 * A model reference identifying the source file and its content revision.
 * Matches the viewer's modelReferenceSchema: { source, revision, units }.
 */
export function modelReference(filePath: string, units?: string) {
  return { source: resolve(filePath), revision: fileRevision(filePath), units };
}

/**
 * A typed subject reference matching the viewer's subjectReferenceSchema.
 * entityId is parsed into kind=face/edge/vertex/body when possible.
 */
export function subjectReference(filePath: string, entityId: string, units?: string) {
  const kind = entityId.split(":")[0] || "entity";
  return {
    type: "geometry",
    model: modelReference(filePath, units),
    entityId,
    kind,
    locator: { entityId, kind, units },
  };
}

export function kindOf(entityId: string): string {
  return entityId.split(":")[0] || "entity";
}
