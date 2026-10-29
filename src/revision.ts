import { fileURLToPath, pathToFileURL } from 'node:url';
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
      .min(1)
      .optional()
      .describe(
        'Artifact location: a URI such as file:///parts/curved-sector.step, or a plain filesystem path such as /parts/curved-sector.step. Both address the same records, because a path is normalised to a file: URL before anything is stored against it. A relative path resolves against this server working directory. Records are grouped by it; without a URI the revision alone is the key.',
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

/**
 * Whether a locator names a URI rather than a filesystem path.
 *
 * The runtime's own parser answers this, with one exception worth stating: a Windows
 * drive path parses as a URL, because a single letter is a syntactically valid scheme.
 * So the general question goes to `URL.canParse` and only that ambiguity is resolved
 * here. Every scheme a caller hands this server in practice — `file:`, `http:` — is
 * longer than one letter.
 * @param locator - caller-supplied artifact location.
 * @returns whether the locator should be parsed as a URL.
 */
function isUri(locator: string): boolean {
  return URL.canParse(locator) && !/^[a-z]:[\\/]/i.test(locator);
}

/**
 * Canonical URI for a locator.
 *
 * Callers reach for whichever form is in front of them — a path read off disk, or
 * the URI the Geometry server reported — so both are accepted and reduced to one
 * spelling here, before any grouping happens. Without this, a path and its own
 * `file:` URL would silently be two different artifacts.
 * @param locator - caller-supplied artifact location.
 * @returns the canonical URI.
 */
function canonicalUri(locator: string): string {
  return isUri(locator) ? new URL(locator).href : pathToFileURL(resolve(locator)).href;
}

/**
 * Canonical URI of an artifact.
 * @param artifact - artifact reference.
 * @returns the canonical URI, or `undefined` when the artifact carries no location.
 */
export function artifactUri(artifact: ArtifactReference): string | undefined {
  const { uri } = artifact;
  return uri === undefined || uri === '' ? undefined : canonicalUri(uri);
}

export function artifactKey(artifact: ArtifactReference): string {
  return artifactUri(artifact) ?? `revision:${artifact.revision}`;
}

export function artifactAliases(artifact: ArtifactReference): string[] {
  const canonical = artifactUri(artifact);
  if (canonical === undefined) return [`revision:${artifact.revision}`];
  const uri = new URL(canonical);
  if (uri.protocol !== 'file:') return [uri.href];
  const filePath = fileURLToPath(uri);
  return [...new Set([uri.href, filePath, resolve(filePath)])];
}

/**
 * The artifact reference to echo on a recalled record.
 *
 * The revision and the units come from the **stored** row, never from the artifact
 * supplied to recall. A record is bound to the revision it was written against, and
 * inferring historical units from a later revision would invent provenance. Only
 * the locator is taken from the caller, because a record is grouped by locator and
 * the caller supplies the one it asked about.
 * @param stored - revision and units as they were stored at write time.
 * @param current - the artifact the caller supplied.
 * @returns the artifact reference for the response.
 */
export function echoArtifact(
  stored: { readonly revision: string; readonly units: string | null },
  current: ArtifactReference,
): z.output<typeof artifactReferenceSchema> {
  const uri = artifactUri(current);
  return {
    revision: stored.revision,
    ...(uri === undefined ? {} : { uri }),
    format: current.format,
    ...(stored.units === null ? {} : { units: stored.units }),
  };
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
