import { z } from "zod";

export const UI_METHOD_NAMES = [
  "ui.overview",
  "ui.agentStats",
  "ui.list",
  "ui.search",
  "ui.get",
  "ui.forget",
  "ui.status",
  "ui.legacyTrial",
  "ui.upgradeLegacy",
  "ui.agentOrganization",
] as const;

export type UiMethodName = (typeof UI_METHOD_NAMES)[number];

/** 預期錯誤碼；CURSOR_STALE 表示游標已不能用（plugin 重啟、被改、篩選不同），畫面必須從第一頁重來，同一游標重送永遠失敗。 */
export const UI_FAILURE_CODES = [
  "INVALID_PARAMS",
  "CURSOR_STALE",
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
  legacyTrialMax: 50,
  upgradeLegacyMaxLimit: 10,
  upgradeLegacyDefaultLimit: 5,
  upgradeLegacySkipMax: 200,
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

const trialRequestId = z.string().min(8).max(64);

export const uiLegacyTrialRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), requestId: trialRequestId, count: z.number().int().min(1).max(UI_LIMITS.legacyTrialMax) }).strict(),
  z.object({ action: z.literal("stop"), requestId: trialRequestId }).strict(),
]);

export const uiAgentOrganizationRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("run"), agentId: identifier }).strict(),
  z.object({ action: z.literal("stop") }).strict(),
  z.object({ action: z.literal("status"), agentId: identifier }).strict(),
]);

const agentHash = z.string().regex(/^[0-9a-f]{64}$/);

export const uiUpgradeLegacyRequest = z
  .object({
    skip: z.array(agentHash).max(UI_LIMITS.upgradeLegacySkipMax).default([]),
    limit: z.number().int().min(1).max(UI_LIMITS.upgradeLegacyMaxLimit).default(UI_LIMITS.upgradeLegacyDefaultLimit),
  })
  .strict();

/** 名稱表合併後的顯示欄位；名稱缺漏時 displayName 是降級名稱（agent：id 最後一段加（team key）；專案：「專案 」加 id 前 8 碼），name 只在名稱表有時才出現。 */
export const uiAgentNamesSchema = z
  .object({
    displayName: z.string(),
    name: z.string().optional(),
    title: z.string().optional(),
    teamKey: z.string(),
    teamName: z.string().optional(),
  })
  .strict();

export const uiProjectNamesSchema = z.object({ displayName: z.string(), name: z.string().optional() }).strict();

export const uiNamesSchema = z
  .object({ agent: uiAgentNamesSchema.omit({ title: true }), project: uiProjectNamesSchema.nullable() })
  .strict();

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
    names: uiNamesSchema.optional(),
  })
  .strict();

const projectCount = z.object({ projectId: identifier, name: z.string().optional(), displayName: z.string().optional(), count }).strict();

export const uiAgentCardSchema = z
  .object({
    id: identifier,
    name: z.string().optional(),
    displayName: z.string().optional(),
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

const profileOmitted = z.object({ agents: count, teams: count, projects: count }).strict();

/** incomplete＝Core 因上限丟掉了部分名稱（omitted 任一項大於 0）；corrupt＝磁碟上的名稱表壞了、目前以空表運作。 */
const profileStamp = z
  .object({
    generation: z.string().nullable(),
    receivedAt: z.string().nullable(),
    incomplete: z.boolean().optional(),
    corrupt: z.boolean().optional(),
    omitted: profileOmitted.optional(),
  })
  .strict();

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
    complete: z.boolean().optional(),
    profile: profileStamp,
    storage: z.object({ status: z.string(), unavailableAgents: count, upgradableAgents: count.optional() }).strict(),
  })
  .strict();

const namespaceStat = z
  .object({
    scope,
    projectId: identifier.nullable(),
    count,
    firstAt: timestamp.nullable(),
    lastAt: timestamp.nullable(),
    project: uiProjectNamesSchema.nullable().optional(),
  })
  .strict();

export const uiAgentStatsSuccess = z
  .object({
    ok: z.literal(true),
    agentId: identifier,
    agent: uiAgentNamesSchema.optional(),
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
    names: uiNamesSchema.optional(),
    receipts: z.array(uiReceiptSchema).max(UI_LIMITS.receiptsMax),
    sameSession: z.array(uiItemSchema).max(UI_LIMITS.sameSessionMax),
  })
  .strict();

export const uiForgetSuccess = z.object({ ok: z.literal(true), forgotten: z.boolean() }).strict();

const trialHaltReason = z.object({ code: z.string(), phase: z.string().nullable(), hostCode: z.string().nullable(), localCode: z.string().nullable(), consecutive: count }).strict();
const trialFailureGroup = z.object({ code: z.string(), phase: z.string().nullable(), hostCode: z.string().nullable(), localCode: z.string().nullable(), count }).strict();

export const uiTrialSchema = z.object({
  batchId: z.string(),
  state: z.enum(["running", "completed", "halted", "stopped"]),
  requested: count,
  adopted: count,
  attempted: count,
  committed: count,
  emptySuccess: count,
  skipped: count,
  failed: count,
  untried: count,
  startedAt: count,
  endedAt: count.nullable(),
  haltReason: trialHaltReason.nullable(),
  failures: z.array(trialFailureGroup).max(5),
}).strict();

export const uiLegacyTrialSuccess = z.object({
  ok: z.literal(true),
  action: z.enum(["start", "stop"]),
  requested: count,
  adopted: count,
  candidates: count,
  skippedAmbiguous: count,
  blocked: z.enum(["disabled", "trial_running", "no_candidates", "not_running"]).nullable(),
  trial: uiTrialSchema.nullable(),
}).strict();

export const pauseReasonSchema = z.enum(["stall", "model_not_configured", "model_policy_denied", "operator_reconcile"]);
export const stallSchema = z.object({ count, limit: count }).strict();

export const uiAgentRunSchema = z.object({
  agentId: z.string().max(200),
  state: z.enum(["running", "stopping", "completed", "stopped"]),
  total: count,
  done: count,
  failed: count,
  untried: count,
  startedAt: count,
  endedAt: count.nullable(),
  lastError: z.string().nullable(),
}).strict();

export const uiAgentOrganizationSuccess = z.object({
  ok: z.literal(true),
  action: z.enum(["run", "stop", "status"]),
  agentId: z.string().max(200),
  pending: count,
  blocked: z.enum(["disabled", "running", "other_running", "no_candidates", "not_running"]).nullable(),
  run: uiAgentRunSchema.nullable(),
  waiting: z.object({ sinceMs: count }).strict().nullable().optional(),
  pauseReason: pauseReasonSchema.nullable().optional(),
  stall: stallSchema.nullable().optional(),
}).strict();

export const uiUpgradeLegacySuccess = z
  .object({
    ok: z.literal(true),
    upgraded: count,
    failed: count,
    results: z.array(z.object({ agentHash, ok: z.boolean(), code: z.enum(UI_FAILURE_CODES).optional() }).strict()).max(UI_LIMITS.upgradeLegacyMaxLimit),
    remaining: count,
  })
  .strict();

export const uiStatusSuccess = z
  .object({
    ok: z.literal(true),
    version: z.string(),
    cairnCommit: z.string(),
    storage: z.object({ status: z.string() }).strict(),
    profile: z
      .object({
        generation: z.string().nullable(),
        receivedAt: z.string().nullable(),
        agents: count,
        projects: count,
        teams: count.optional(),
        incomplete: z.boolean().optional(),
        corrupt: z.boolean().optional(),
        omitted: profileOmitted.optional(),
        sink: z.object({ pending: count, lastWrittenAtMs: count.nullable() }).strict().nullable(),
        sinkReceivedAt: z.string().nullable().optional(),
      })
      .strict(),
    lastWriteAt: timestamp.nullable(),
    uptimeSec: count,
    organization: z.object({
      state: z.enum(["disabled", "idle", "running", "paused", "error"]),
      admitted: count.nullable(),
      pending: count,
      replyReady: count,
      completed: count,
      legacyUnlinked: count,
      legacyTrialCandidates: count.optional(),
      trial: uiTrialSchema.nullable().optional(),
      schemaSkipped: count.nullable(),
      diagnosticsAvailable: z.boolean().nullable(),
      sourceGeneration: z.string().nullable(),
      sourceHighWatermark: z.string().nullable(),
      sourcePages: count.nullable(),
      sourceScanned: count.nullable(),
      sourceReceived: count.nullable(),
      sourceEligible: count.nullable(),
      sourceCheckpointed: z.boolean().nullable(),
      lastError: z.string().nullable(),
      errorPhase: z.string().nullable(),
      hostErrorCode: z.string().nullable(),
      localErrorCode: z.string().nullable().optional(),
      retryable: z.boolean().nullable(),
      partialDelivered: z.boolean().nullable(),
      lastAttemptAt: count.nullable(),
      updatedAt: count.nullable(),
      waiting: z.object({ sinceMs: count }).strict().nullable().optional(),
      pauseReason: pauseReasonSchema.nullable().optional(),
      stall: stallSchema.nullable().optional(),
      dailyRound: z.object({
        date: z.string().length(10),
        roundId: z.string(),
        state: z.enum(["running", "paused", "completed"]),
        nextResumeAt: count.nullable(),
        snapshotHighWatermark: count,
        snapshotMembers: count,
        completedMembers: count,
        deferredMembers: count,
      }).strict().nullable(),
    }).strict().optional(),
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
  "ui.legacyTrial": { request: uiLegacyTrialRequest, success: uiLegacyTrialSuccess },
  "ui.upgradeLegacy": { request: uiUpgradeLegacyRequest, success: uiUpgradeLegacySuccess },
  "ui.agentOrganization": { request: uiAgentOrganizationRequest, success: uiAgentOrganizationSuccess },
} as const satisfies Record<UiMethodName, { request: z.ZodTypeAny; success: z.ZodTypeAny }>;

export type UiFailure = z.infer<typeof uiFailureSchema>;
export type UiStatus = z.infer<typeof uiStatusSuccess>;
export type UiRef = z.infer<typeof uiRefSchema>;
export type UiItem = z.infer<typeof uiItemSchema>;
export type UiWork = z.infer<typeof uiWorkSchema>;
export type UiNames = z.infer<typeof uiNamesSchema>;
export type UiAgentNames = z.infer<typeof uiAgentNamesSchema>;
export type UiProjectNames = z.infer<typeof uiProjectNamesSchema>;
export type UiOverviewRequest = z.infer<typeof uiOverviewRequest>;
export type UiAgentStatsRequest = z.infer<typeof uiAgentStatsRequest>;
export type UiGetRequest = z.infer<typeof uiGetRequest>;
export type UiForgetRequest = z.infer<typeof uiForgetRequest>;
export type UiListRequest = z.infer<typeof uiListRequest>;
export type UiSearchRequest = z.infer<typeof uiSearchRequest>;
export type UiLegacyTrialRequest = z.infer<typeof uiLegacyTrialRequest>;
export type UiUpgradeLegacyRequest = z.infer<typeof uiUpgradeLegacyRequest>;
export type UiTrial = z.infer<typeof uiTrialSchema>;
export type UiAgentOrganizationRequest = z.infer<typeof uiAgentOrganizationRequest>;
export type UiAgentRun = z.infer<typeof uiAgentRunSchema>;
export type UiAgentOrganization = z.infer<typeof uiAgentOrganizationSuccess>;

export type UiParamsResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

export function parseUiParams(method: UiMethodName, params: unknown): UiParamsResult {
  const parsed = UI_METHOD_SCHEMAS[method].request.safeParse(params);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

export function parseUiResponse(method: UiMethodName, response: unknown): boolean {
  return UI_METHOD_SCHEMAS[method].success.safeParse(response).success || uiFailureSchema.safeParse(response).success;
}
