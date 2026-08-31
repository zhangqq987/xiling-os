import type { FastifyInstance } from "fastify";
import { literatureQuerySchema, paperParamsSchema, paperSchema, projectIdQuerySchema, scopedPaperSchema, toPaperRecord } from "@xiling/api-contracts";
import type { EvidenceStore } from "@xiling/knowledge";
import { buildLiteratureGraph, createOceanHeatwaveFixture, type LiteratureSearchService } from "@xiling/literature";

export function registerLiteratureRoutes(app: FastifyInstance, dependencies: { literature: LiteratureSearchService; credentialsReady: Promise<unknown>; evidence: EvidenceStore; validateClaimRevision(projectId: string, entityId: string): Promise<boolean> }): void {
  app.get("/api/v1/literature/demo", async () => { const fixture = createOceanHeatwaveFixture(); return buildLiteratureGraph(fixture.papers, fixture.seedIds, { fetchedAt: "2026-08-23T00:00:00.000Z" }); });
  app.get("/api/v1/literature/search", async (request, reply) => {
    const parsed = literatureQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    await dependencies.credentialsReady;
    try { const result = await dependencies.literature.search(parsed.data.q, parsed.data.limit); const graph = result.papers.length ? buildLiteratureGraph(result.papers, [result.papers[0]!.id], { limit: parsed.data.limit, fetchedAt: result.fetchedAt }) : undefined; return { ...result, ...(graph ? { graph } : {}) }; }
    catch (error) { return reply.code(503).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.get("/api/v1/evidence", async (request, reply) => { const parsed = projectIdQuerySchema.safeParse(request.query); return parsed.success ? dependencies.evidence.listEvidence(parsed.data.projectId) : reply.code(400).send({ error: parsed.error.issues }); });
  app.post("/api/v1/evidence", async (request, reply) => {
    const scoped = scopedPaperSchema.safeParse(request.body);
    if (scoped.success) {
      if (scoped.data.claimRevisionId && !await dependencies.validateClaimRevision(scoped.data.projectId, scoped.data.claimRevisionId)) return reply.code(400).send({ error: "Evidence target must be an existing ClaimRevision in this project" });
      return reply.code(201).send(dependencies.evidence.saveEvidence(
      scoped.data.projectId,
      toPaperRecord(scoped.data.paper),
      scoped.data.note,
      scoped.data.stance,
      scoped.data.confidence,
      {
        sourceQuote: scoped.data.sourceQuote,
        limitations: scoped.data.limitations,
        ...(scoped.data.sourceLocator ? { sourceLocator: scoped.data.sourceLocator } : {}),
        ...(scoped.data.claimRevisionId ? { claimRevisionId: scoped.data.claimRevisionId } : {}),
      },
      ));
    }
    const legacy = paperSchema.safeParse(request.body);
    return legacy.success ? reply.code(400).send({ error: "证据必须指定所属项目：请使用带 projectId 的 scoped paper 格式" }) : reply.code(400).send({ error: scoped.error.issues });
  });
  app.post("/api/v1/evidence/:paperId", async (request, reply) => {
    const params = paperParamsSchema.safeParse(request.params); const query = projectIdQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "invalid evidence request" });
    const paper = createOceanHeatwaveFixture().papers.find((item) => item.id === params.data.paperId);
    return paper ? reply.code(201).send(dependencies.evidence.saveEvidence(query.data.projectId, paper)) : reply.code(404).send({ error: "Paper not found" });
  });
  app.delete("/api/v1/evidence/:paperId", async (request, reply) => {
    const params = paperParamsSchema.safeParse(request.params); const query = projectIdQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "invalid evidence request" });
    return dependencies.evidence.deleteEvidence(query.data.projectId, params.data.paperId) ? { status: "deleted" } : reply.code(404).send({ error: "Evidence not found" });
  });
}
