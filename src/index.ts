#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { getDb } from './db.js'

async function runTool<T>(fn: () => Promise<T>) {
  try {
    const data = await fn()
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { content: [{ type: 'text' as const, text: message }], isError: true }
  }
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const
const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false } as const
const annotationKind = z.enum(['tag', 'note', 'claim'])
const annotationStatus = z.enum(['proposed', 'confirmed', 'rejected'])
const annotationSource = z.enum(['user', 'ai', 'tool'])

serveStdio(() => {
  const server = new McpServer(
    { name: 'review-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )

  server.registerTool(
    'create_annotation',
    {
      description: 'Create a tag, note, or claim attached to one or more CAD body/face entity IDs.',
      inputSchema: z.object({
        entityIds: z.array(z.string()).min(1).max(100),
        kind: annotationKind,
        text: z.string().min(1),
        status: annotationStatus.default('proposed'),
        source: annotationSource.default('user'),
        confidence: z.number().min(0).max(1).optional(),
        evidence: z.record(z.string(), z.unknown()).optional(),
        createdBy: z.string().optional(),
      }).strict(),
      annotations: WRITE,
    },
    async ({ entityIds, kind, text, status, source, confidence, evidence, createdBy }) => runTool(async () => {
      const db = getDb()
      const id = randomUUID()
      db.prepare(`INSERT INTO annotations (id, kind, text, status, source, confidence, evidence_json, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, kind, text, status, source, confidence ?? null, evidence ? JSON.stringify(evidence) : null, createdBy ?? source)
      const entityStmt = db.prepare('INSERT INTO annotation_entities (annotation_id, entity_id) VALUES (?, ?)')
      for (const entityId of entityIds) entityStmt.run(id, entityId)
      db.prepare('INSERT INTO review_trail (action, entity_id, detail, created_by) VALUES (?, ?, ?, ?)')
        .run('create_annotation', entityIds[0], JSON.stringify({ annotationId: id, entityIds, kind, text, status, source }), createdBy ?? source)
      return { annotation: { id, entityIds, kind, text, status, source, confidence: confidence ?? null } }
    }),
  )

  server.registerTool(
    'update_annotation_status',
    {
      description: 'Confirm or reject an existing annotation.',
      inputSchema: z.object({
        annotationId: z.string(),
        status: annotationStatus,
        updatedBy: z.string().optional(),
      }).strict(),
      annotations: WRITE,
    },
    async ({ annotationId, status, updatedBy }) => runTool(async () => {
      const db = getDb()
      const result = db.prepare("UPDATE annotations SET status = ?, updated_at = datetime('now') WHERE id = ?")
        .run(status, annotationId)
      if (Number(result.changes) === 0) throw new Error(`Annotation ${annotationId} not found`)
      db.prepare('INSERT INTO review_trail (action, detail, created_by) VALUES (?, ?, ?)')
        .run('update_annotation_status', JSON.stringify({ annotationId, status }), updatedBy ?? 'user')
      return { annotationId, status }
    }),
  )

  server.registerTool(
    'query_annotations',
    {
      description: 'Query tag, note, and claim annotations by entity IDs, kind, status, or source.',
      inputSchema: z.object({
        entityIds: z.array(z.string()).min(1).max(100).optional(),
        kinds: z.array(annotationKind).optional(),
        statuses: z.array(annotationStatus).optional(),
        sources: z.array(annotationSource).optional(),
        limit: z.number().int().min(1).max(500).default(100),
        offset: z.number().int().min(0).default(0),
      }).strict(),
      annotations: READ_ONLY,
    },
    async ({ entityIds, kinds, statuses, sources, limit, offset }) => runTool(async () => {
      const db = getDb()
      const params: (string | number)[] = []
      const clauses: string[] = []
      if (entityIds?.length) {
        clauses.push(`ae.entity_id IN (${entityIds.map(() => '?').join(',')})`)
        params.push(...entityIds)
      }
      if (kinds?.length) { clauses.push(`a.kind IN (${kinds.map(() => '?').join(',')})`); params.push(...kinds) }
      if (statuses?.length) { clauses.push(`a.status IN (${statuses.map(() => '?').join(',')})`); params.push(...statuses) }
      if (sources?.length) { clauses.push(`a.source IN (${sources.map(() => '?').join(',')})`); params.push(...sources) }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
      params.push(limit, offset)
      const rows = db.prepare(`SELECT a.id, a.kind, a.text, a.status, a.source, a.confidence, a.evidence_json,
          a.created_by, a.created_at, a.updated_at, group_concat(ae.entity_id) AS entity_ids
        FROM annotations a
        JOIN annotation_entities ae ON ae.annotation_id = a.id
        ${where}
        GROUP BY a.id
        ORDER BY a.updated_at DESC
        LIMIT ? OFFSET ?`).all(...params) as Record<string, unknown>[]
      return {
        annotations: rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          text: row.text,
          status: row.status,
          source: row.source,
          confidence: row.confidence,
          evidence: row.evidence_json ? JSON.parse(row.evidence_json as string) : undefined,
          entityIds: String(row.entity_ids ?? '').split(',').filter(Boolean),
          createdBy: row.created_by,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
      }
    }),
  )

  server.registerTool(
    'query_events',
    {
      description: 'Query review audit events.',
      inputSchema: z.object({
        action: z.string().optional(),
        entityId: z.string().optional(),
        limit: z.number().int().min(1).max(500).default(50),
        offset: z.number().int().min(0).default(0),
      }).strict(),
      annotations: READ_ONLY,
    },
    async ({ action, entityId, limit, offset }) => runTool(async () => {
      const db = getDb()
      const params: (string | number)[] = []
      const clauses: string[] = []
      if (action) { clauses.push('action = ?'); params.push(action) }
      if (entityId) { clauses.push('entity_id = ?'); params.push(entityId) }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
      params.push(limit, offset)
      const entries = db.prepare(`SELECT id, action, entity_id, detail, created_by, created_at
        FROM review_trail ${where}
        ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params)
      return { entries }
    }),
  )

  return server
})
