import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';

export const artifactReferenceSchema = z
  .object({
    revision: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .describe(
        'sha256 revision of the artifact, copied from a Geometry inspect result. It is the anchor every record is stored against, and recall compares it to mark records stale.',
      ),
    uri: z
      .string()
      .url()
      .optional()
      .describe(
        'Artifact location, as returned by inspect. Records are grouped by it; without a URI the revision alone is the key.',
      ),
    format: z.literal('step').describe("Always 'step'."),
    units: z.string().optional().describe('Spatial unit of the source file, echoed from inspect.'),
  })
  .strict();

export const subjectReferenceSchema = z
  .object({
    type: z.literal('geometry'),
    artifact: artifactReferenceSchema,
    entity: z
      .object({
        authority: z.literal('cad-mcp-server'),
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
  return artifact.uri ? new URL(artifact.uri).href : `revision:${artifact.revision}`;
}

export function artifactAliases(artifact: ArtifactReference): string[] {
  if (!artifact.uri) return [artifactKey(artifact)];
  const uri = new URL(artifact.uri);
  if (uri.protocol !== 'file:') return [uri.href];
  const filePath = fileURLToPath(uri);
  return [...new Set([uri.href, filePath, resolve(filePath)])];
}

export function subjectReference(
  artifact: ArtifactReference,
  id: string,
  idScheme: string,
): SubjectReference {
  const entityId = id.split('/').at(-1) ?? id;
  const kind = entityId.split(':')[0] || 'entity';
  return {
    type: 'geometry',
    artifact,
    entity: { authority: 'cad-mcp-server', idScheme, id, kind },
  };
}
