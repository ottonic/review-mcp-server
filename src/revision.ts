import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";

export const artifactReferenceSchema = z
  .object({
    revision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    uri: z.string().url().optional(),
    format: z.literal("step"),
    units: z.string().optional(),
  })
  .strict();

export const subjectReferenceSchema = z
  .object({
    type: z.literal("geometry"),
    artifact: artifactReferenceSchema,
    entity: z
      .object({
        authority: z.literal("cad-mcp-server"),
        idScheme: z.string().min(1),
        id: z.string().min(1),
        kind: z.string().min(1),
      })
      .strict(),
    locator: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type ArtifactReference = z.output<typeof artifactReferenceSchema>;
export type SubjectReference = z.output<typeof subjectReferenceSchema>;

export function artifactKey(artifact: ArtifactReference): string {
  return artifact.uri
    ? new URL(artifact.uri).href
    : `revision:${artifact.revision}`;
}

export function artifactAliases(artifact: ArtifactReference): string[] {
  if (!artifact.uri) return [artifactKey(artifact)];
  const uri = new URL(artifact.uri);
  if (uri.protocol !== "file:") return [uri.href];
  const filePath = fileURLToPath(uri);
  return [...new Set([uri.href, filePath, resolve(filePath)])];
}

export function artifactForSource(
  source: string,
  revision: string,
): ArtifactReference | undefined {
  if (!/^sha256:[a-f0-9]{64}$/.test(revision)) return undefined;
  let uri: string | undefined;
  try {
    uri = source.startsWith("revision:")
      ? undefined
      : source.includes("://")
        ? new URL(source).href
        : pathToFileURL(resolve(source)).href;
  } catch {
    uri = undefined;
  }
  return { revision, ...(uri ? { uri } : {}), format: "step", units: "mm" };
}

export function subjectReference(
  artifact: ArtifactReference,
  id: string,
  idScheme: string,
): SubjectReference {
  const entityId = id.split("/").at(-1) ?? id;
  const kind = entityId.split(":")[0] || "entity";
  return {
    type: "geometry",
    artifact,
    entity: { authority: "cad-mcp-server", idScheme, id, kind },
  };
}
