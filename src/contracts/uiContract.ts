import { z } from "zod";

export const UI_METHOD_NAMES = [
  "ui.overview",
  "ui.agentStats",
  "ui.list",
  "ui.search",
  "ui.get",
  "ui.forget",
  "ui.status",
] as const;

export type UiMethodName = (typeof UI_METHOD_NAMES)[number];

export const UI_FAILURE_CODES = [
  "NOT_IMPLEMENTED",
  "INVALID_PARAMS",
  "INVALID_CURSOR",
  "NOT_FOUND",
  "REVISION_CONFLICT",
  "STORAGE_BUSY",
  "STORAGE_UNSUPPORTED",
  "RESOURCE_BUSY",
] as const;

export type UiFailureCode = (typeof UI_FAILURE_CODES)[number];

export const UI_LIMITS = {
  overviewMaxLimit: 200,
  overviewDefaultLimit: 60,
  listMaxLimit: 24,
  listDefaultLimit: 12,
  queryMaxChars: 100,
  cursorMaxChars: 1024,
  contentMaxChars: 4000,
  receiptsMax: 12,
  sameSessionMax: 8,
  overviewProjectsMax: 5,
  repeatedRequestsMax: 8,
  representativeMax: 4,
  overviewSnippetChars: 120,
  listSnippetChars: 160,
} as const;

const identifier = z.string().min(1).max(200);
const scope = z.enum(["personal", "project"]);
const kind = z.enum(["fact", "preference", "decision", "instruction", "context"]);
const count = z.number().int().min(0);
const timestamp = z.string().min(1).max(40);
const cursor = z.string().min(1).max(UI_LIMITS.cursorMaxChars);
const tzOffsetMin = z.number().int().min(-840).max(840);
const cursorOrNull = cursor.nullable();

// why: Cairn stores updated_at as Date.toISOString(), so a filter bound must be that exact form or the string comparison in SQL would misorder
const isoInstant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value);

const codePointsAtMost = (limit: number) =>
  z.string().refine((value) => [...value].length <= limit);

const scopeMatchesProject = (value: { scope?: string | undefined; projectId?: string | null | undefined }): boolean =>
  value.scope === "personal" ? value.projectId === null || value.projectId === undefined : true;

const refShape = {
  agentId: identifier,
  scope,
  projectId: identifier.nullable(),
  memoryId: identifier,
};

const refRule = (value: { scope: string; projectId: string | null }): boolean =>
  value.scope === "personal" ? value.projectId === null : value.projectId !== null;

export const uiRefSchema = z.object(refShape).strict().refine(refRule);

const filterShape = {
  agentId: identifier.optional(),
  scope: scope.optional(),
  projectId: identifier.optional(),
  sinceIso: isoInstant.optional(),
  untilIso: isoInstant.optional(),
  cli: z.string().min(1).max(64).optional(),
};

export const uiOverviewRequest = z
  .object({
    tzOffsetMin,
    dayStartIso: isoInstant,
    limit: z.number().int().min(1).max(UI_LIMITS.overviewMaxLimit).default(UI_LIMITS.overviewDefaultLimit),
    cursor: cursor.optional(),
  })
  .strict();

export const uiAgentStatsRequest = z.object({ agentId: identifier, tzOffsetMin }).strict();

export const uiListRequest = z
  .object({
    ...filterShape,
    limit: z.number().int().min(1).max(UI_LIMITS.listMaxLimit).default(UI_LIMITS.listDefaultLimit),
    cursor: cursor.optional(),
  })
  .strict()
  .refine(scopeMatchesProject);

export const uiSearchRequest = z
  .object({
    q: z.string().min(1).max(UI_LIMITS.queryMaxChars),
    ...filterShape,
    limit: z.number().int().min(1).max(UI_LIMITS.listMaxLimit).default(UI_LIMITS.listDefaultLimit),
    cursor: cursor.optional(),
  })
  .strict()
  .refine(scopeMatchesProject);

export const uiGetRequest = uiRefSchema;

export const uiForgetRequest = z
  .object({ ...refShape, expectedRevision: z.number().int().min(1) })
  .strict()
  .refine(refRule);

export const uiStatusRequest = z.object({}).strict();

export const uiWorkSchema = z
  .object({
    startIso: timestamp,
    endIso: timestamp,
    cli: z.string().nullable(),
    model: z.string().nullable(),
    title: z.string().nullable(),
  })
  .strict();

export const uiItemSchema = z
  .object({
    ref: uiRefSchema,
    kind,
    revision: z.number().int().min(1),
    updatedAt: timestamp,
    snippet: codePointsAtMost(UI_LIMITS.listSnippetChars),
    work: uiWorkSchema.optional(),
    receiptCount: count,
  })
  .strict();

const projectCount = z.object({ projectId: identifier, name: z.string().optional(), count }).strict();

export const uiAgentCardSchema = z
  .object({
    id: identifier,
    name: z.string().optional(),
    team: z.object({ key: z.string(), name: z.string().optional() }).strict(),
    title: z.string().optional(),
    counts: z
      .object({
        personal: count,
        projects: z.array(projectCount).max(UI_LIMITS.overviewProjectsMax),
        otherProjects: count,
        total: count,
      })
      .strict(),
    lastAt: timestamp.nullable(),
    spark14: z.array(count).length(14),
    latest: z.object({ snippet: codePointsAtMost(UI_LIMITS.overviewSnippetChars), at: timestamp }).strict().nullable(),
  })
  .strict();

const profileStamp = z.object({ generation: z.string().nullable(), receivedAt: z.string().nullable() }).strict();

export const uiOverviewSuccess = z
  .object({
    ok: z.literal(true),
    tiles: z
      .object({
        totalMemories: count,
        writtenToday: count,
        activeAgents7d: count,
        agents: count,
        lastWriteAt: timestamp.nullable(),
      })
      .strict(),
    agents: z.array(uiAgentCardSchema),
    nextCursor: cursorOrNull,
    profile: profileStamp,
    storage: z.object({ status: z.string(), unavailableAgents: count }).strict(),
  })
  .strict();

const namespaceStat = z
  .object({ scope, projectId: identifier.nullable(), count, firstAt: timestamp.nullable(), lastAt: timestamp.nullable() })
  .strict();

export const uiAgentStatsSuccess = z
  .object({
    ok: z.literal(true),
    agentId: identifier,
    namespaces: z.array(namespaceStat),
    byDay30: z.array(z.object({ date: z.string().length(10), count }).strict()).max(30),
    byHour: z.array(count).length(24),
    byWeekday: z.array(count).length(7),
    tools: z.array(z.object({ cli: z.string().nullable(), model: z.string().nullable(), n: count }).strict()),
    repeatedRequests: z.array(z.object({ title: z.string(), count }).strict()).max(UI_LIMITS.repeatedRequestsMax),
    representative: z.array(uiItemSchema).max(UI_LIMITS.representativeMax),
    sampled: z.boolean(),
  })
  .strict();

export const uiListSuccess = z
  .object({ ok: z.literal(true), items: z.array(uiItemSchema).max(UI_LIMITS.listMaxLimit), nextCursor: cursorOrNull })
  .strict();

export const uiSearchSuccess = z
  .object({
    ok: z.literal(true),
    items: z.array(uiItemSchema).max(UI_LIMITS.listMaxLimit),
    nextCursor: cursorOrNull,
    scanned: z.object({ namespaces: count, complete: z.boolean() }).strict(),
    normalizedQuery: z.string(),
    mode: z.literal("literal"),
  })
  .strict();

export const uiReceiptSchema = z
  .object({
    client: z.string(),
    sessionId: z.string(),
    eventId: z.string(),
    role: z.enum(["user", "assistant"]),
    createdAt: timestamp,
  })
  .strict();

export const uiGetSuccess = z
  .object({
    ok: z.literal(true),
    memory: z
      .object({
        ref: uiRefSchema,
        kind,
        revision: z.number().int().min(1),
        createdAt: timestamp,
        updatedAt: timestamp,
        content: codePointsAtMost(UI_LIMITS.contentMaxChars),
      })
      .strict(),
    work: uiWorkSchema.optional(),
    receipts: z.array(uiReceiptSchema).max(UI_LIMITS.receiptsMax),
    sameSession: z.array(uiItemSchema).max(UI_LIMITS.sameSessionMax),
  })
  .strict();

export const uiForgetSuccess = z.object({ ok: z.literal(true), forgotten: z.boolean() }).strict();

export const uiStatusSuccess = z
  .object({
    ok: z.literal(true),
    stub: z.boolean().optional(),
    version: z.string(),
    cairnCommit: z.string(),
    storage: z.object({ status: z.string() }).strict(),
    profile: z
      .object({
        generation: z.string().nullable(),
        receivedAt: z.string().nullable(),
        agents: count,
        projects: count,
        sink: z.object({ pending: count, lastWrittenAtMs: count.nullable() }).strict().nullable(),
      })
      .strict(),
    lastWriteAt: timestamp.nullable(),
    uptimeSec: count,
  })
  .strict();

export const uiFailureSchema = z
  .object({
    ok: z.literal(false),
    code: z.enum(UI_FAILURE_CODES),
    retryable: z.boolean(),
    message: z.string().max(200).optional(),
  })
  .strict();

export const UI_METHOD_SCHEMAS = {
  "ui.overview": { request: uiOverviewRequest, success: uiOverviewSuccess },
  "ui.agentStats": { request: uiAgentStatsRequest, success: uiAgentStatsSuccess },
  "ui.list": { request: uiListRequest, success: uiListSuccess },
  "ui.search": { request: uiSearchRequest, success: uiSearchSuccess },
  "ui.get": { request: uiGetRequest, success: uiGetSuccess },
  "ui.forget": { request: uiForgetRequest, success: uiForgetSuccess },
  "ui.status": { request: uiStatusRequest, success: uiStatusSuccess },
} as const satisfies Record<UiMethodName, { request: z.ZodTypeAny; success: z.ZodTypeAny }>;

export type UiFailure = z.infer<typeof uiFailureSchema>;
export type UiStatus = z.infer<typeof uiStatusSuccess>;
export type UiRef = z.infer<typeof uiRefSchema>;
export type UiItem = z.infer<typeof uiItemSchema>;
export type UiWork = z.infer<typeof uiWorkSchema>;
export type UiOverviewRequest = z.infer<typeof uiOverviewRequest>;
export type UiListRequest = z.infer<typeof uiListRequest>;
export type UiSearchRequest = z.infer<typeof uiSearchRequest>;

export type UiParamsResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

export function parseUiParams(method: UiMethodName, params: unknown): UiParamsResult {
  const parsed = UI_METHOD_SCHEMAS[method].request.safeParse(params);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

export function parseUiResponse(method: UiMethodName, response: unknown): boolean {
  return UI_METHOD_SCHEMAS[method].success.safeParse(response).success || uiFailureSchema.safeParse(response).success;
}
