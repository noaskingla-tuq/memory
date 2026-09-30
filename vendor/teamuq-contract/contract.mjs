// packages/features/agent-memory/src/contracts/memoryPluginContract.ts
import { z } from "zod";
var MEMORY_PLUGIN_ID = "teamuq.memory";
var MEMORY_CONTRACT_VERSION = 1;
var MEMORY_CONTRACT_VERSIONS = [1];
var MEMORY_PLUGIN_METHODS = {
  remember: "memory.remember@1",
  inspect: "memory.inspect@1",
  diagnose: "diagnose",
  profileSync: "memory.profile.sync@1"
};
var MEMORY_PLUGIN_METHOD_NAMES = [
  MEMORY_PLUGIN_METHODS.remember,
  MEMORY_PLUGIN_METHODS.inspect,
  MEMORY_PLUGIN_METHODS.diagnose,
  MEMORY_PLUGIN_METHODS.profileSync
];
var MEMORY_LIMITS = {
  maxOps: 16,
  paramsMaxBytes: 256 * 1024,
  resultMaxBytes: 64 * 1024,
  inspectBudgetBytes: 6e4,
  callTimeoutMs: 3e4,
  identifierMaxChars: 200,
  operationIdMaxChars: 128,
  contentMaxChars: 4e3,
  inspectMaxLimit: 12,
  cursorMaxChars: 8192
};
var MEMORY_PROFILE_LIMITS = {
  maxAgents: 4096,
  maxTeams: 1024,
  maxProjects: 4096,
  maxParts: 32,
  partBudgetBytes: 192 * 1024,
  agentNameMaxChars: 120,
  teamNameMaxChars: 120,
  titleMaxChars: 120,
  projectNameMaxChars: 200,
  canonicalVersion: 1
};
var MEMORY_ERROR_CODES = [
  "INVALID_INPUT",
  "PROJECT_UNBOUND",
  "MODEL_NOT_CONFIGURED",
  "MODEL_POLICY_DENIED",
  "MODEL_TIMEOUT",
  "MODEL_OUTPUT_INVALID",
  "TOKEN_COUNT_UNAVAILABLE",
  "REVISION_CONFLICT",
  "CURSOR_STALE",
  "IDEMPOTENCY_CONFLICT",
  "MEMORY_SUPPRESSED",
  "RESOURCE_BUSY",
  "STORAGE_BUSY",
  "STORAGE_UNSAFE",
  "STORAGE_UNSUPPORTED",
  "DEPENDENCY_INCOMPATIBLE",
  "INTERNAL"
];
var MEMORY_RETRYABLE_ERROR_CODES = [
  "MODEL_TIMEOUT",
  "REVISION_CONFLICT",
  "CURSOR_STALE",
  "RESOURCE_BUSY",
  "STORAGE_BUSY"
];
var MEMORY_CALL_ERROR_CODES = [
  "unknown_method",
  "invalid_params",
  "result_too_large",
  "internal"
];
var identifier = z.string().min(1).max(MEMORY_LIMITS.identifierMaxChars);
var scope = z.enum(["personal", "project"]);
var kind = z.enum(["fact", "preference", "decision", "instruction", "context"]);
var memoryActorSchema = z.object({
  agentId: identifier,
  projectId: identifier.nullable(),
  sessionId: identifier,
  providerId: identifier
}).strict();
var memoryRememberInputSchema = z.object({
  scope,
  content: z.string().min(1).max(MEMORY_LIMITS.contentMaxChars),
  kind,
  operationId: z.string().min(1).max(MEMORY_LIMITS.operationIdMaxChars)
}).strict();
var memoryInspectInputSchema = z.object({
  scope,
  memoryId: identifier.optional(),
  limit: z.number().int().min(1).max(MEMORY_LIMITS.inspectMaxLimit).optional(),
  cursor: z.string().min(1).max(MEMORY_LIMITS.cursorMaxChars).optional()
}).strict();
var memoryRememberRequestSchema = z.object({
  actor: memoryActorSchema,
  ops: z.array(memoryRememberInputSchema).min(1).max(MEMORY_LIMITS.maxOps)
}).strict();
var memoryInspectRequestSchema = z.object({
  actor: memoryActorSchema,
  input: memoryInspectInputSchema
}).strict();
var memoryDiagnoseRequestSchema = z.object({}).strict();
var memoryFailureSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.enum(MEMORY_ERROR_CODES),
    message: z.string(),
    retryable: z.boolean(),
    requestId: z.string()
  })
});
var memoryRememberValueSchema = z.object({
  memory: z.object({ id: identifier }),
  deduplicated: z.boolean()
});
var memoryInspectValueSchema = z.record(z.unknown());
var memoryRememberResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: memoryRememberValueSchema, requestId: z.string() }),
  memoryFailureSchema
]);
var memoryInspectResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: memoryInspectValueSchema, requestId: z.string() }),
  memoryFailureSchema
]);
var memoryRememberResponseSchema = z.object({
  results: z.array(memoryRememberResultSchema).max(MEMORY_LIMITS.maxOps)
});
var memoryInspectResponseSchema = z.object({
  result: memoryInspectResultSchema,
  nextCursor: z.string().min(1).max(MEMORY_LIMITS.cursorMaxChars).optional(),
  appliedLimit: z.number().int().min(1).max(MEMORY_LIMITS.inspectMaxLimit).optional()
});
var memoryDiagnoseResponseSchema = z.object({
  plugin: z.object({ id: z.string().min(1).max(96), version: z.string().min(1).max(64) }),
  contract: z.object({
    versions: z.array(z.number().int().positive()).min(1).max(16)
  }),
  cairn: z.object({ commit: z.string().min(1).max(64) }),
  node: z.object({ version: z.string().min(1).max(32), sqlite: z.string().min(1).max(32) }),
  storage: z.object({ status: z.string().min(1).max(32) }),
  limits: z.object({
    resultMaxBytes: z.number().int().positive(),
    inspectBudgetBytes: z.number().int().positive(),
    maxOps: z.number().int().positive()
  }),
  contractLockSha256: z.string().regex(/^[0-9a-f]{64}$/)
});
var sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
var count = z.number().int().min(0);
var memoryProfileAgentSchema = z.object({
  id: identifier,
  name: z.string().min(1).max(MEMORY_PROFILE_LIMITS.agentNameMaxChars),
  teamKey: identifier.nullable(),
  title: z.string().min(1).max(MEMORY_PROFILE_LIMITS.titleMaxChars).nullable(),
  enabled: z.boolean()
}).strict();
var memoryProfileTeamSchema = z.object({ key: identifier, name: z.string().min(1).max(MEMORY_PROFILE_LIMITS.teamNameMaxChars) }).strict();
var memoryProfileProjectSchema = z.object({ id: identifier, name: z.string().min(1).max(MEMORY_PROFILE_LIMITS.projectNameMaxChars), archived: z.boolean() }).strict();
var memoryProfileOmittedSchema = z.object({ agents: count, teams: count, projects: count }).strict();
var memoryProfileSinkSchema = z.object({ pending: count, lastWrittenAtMs: count.nullable() }).strict();
var strictlyAscending = (keys) => keys.every((key, index) => index === 0 || keys[index - 1] < key);
var memoryProfileSyncRequestSchema = z.object({
  generation: sha256Hex,
  part: z.number().int().min(1).max(MEMORY_PROFILE_LIMITS.maxParts),
  parts: z.number().int().min(1).max(MEMORY_PROFILE_LIMITS.maxParts),
  agents: z.array(memoryProfileAgentSchema).max(MEMORY_PROFILE_LIMITS.maxAgents),
  teams: z.array(memoryProfileTeamSchema).max(MEMORY_PROFILE_LIMITS.maxTeams),
  projects: z.array(memoryProfileProjectSchema).max(MEMORY_PROFILE_LIMITS.maxProjects),
  omitted: memoryProfileOmittedSchema,
  sink: memoryProfileSinkSchema.nullable()
}).strict().superRefine((value, ctx) => {
  if (value.part > value.parts) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["part"], message: "part_exceeds_parts" });
  if (!strictlyAscending(value.agents.map((entry) => entry.id))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["agents"], message: "agents_not_ascending" });
  if (!strictlyAscending(value.teams.map((entry) => entry.key))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["teams"], message: "teams_not_ascending" });
  if (!strictlyAscending(value.projects.map((entry) => entry.id))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["projects"], message: "projects_not_ascending" });
});
var memoryProfileSyncResponseSchema = z.object({
  accepted: z.literal(true),
  generation: sha256Hex,
  complete: z.boolean(),
  changed: z.boolean(),
  received: z.number().int().min(1).max(MEMORY_PROFILE_LIMITS.maxParts),
  agents: count,
  teams: count,
  projects: count
});
var byKey = (key) => (left, right) => {
  const a = key(left);
  const b = key(right);
  return a < b ? -1 : a > b ? 1 : 0;
};
function memoryProfileCanonicalText(snapshot) {
  return JSON.stringify([
    MEMORY_PROFILE_LIMITS.canonicalVersion,
    [...snapshot.agents].sort(byKey((entry) => entry.id)).map((entry) => [entry.id, entry.name, entry.teamKey, entry.title, entry.enabled]),
    [...snapshot.teams].sort(byKey((entry) => entry.key)).map((entry) => [entry.key, entry.name]),
    [...snapshot.projects].sort(byKey((entry) => entry.id)).map((entry) => [entry.id, entry.name, entry.archived]),
    [snapshot.omitted.agents, snapshot.omitted.teams, snapshot.omitted.projects]
  ]);
}
export {
  MEMORY_CALL_ERROR_CODES,
  MEMORY_CONTRACT_VERSION,
  MEMORY_CONTRACT_VERSIONS,
  MEMORY_ERROR_CODES,
  MEMORY_LIMITS,
  MEMORY_PLUGIN_ID,
  MEMORY_PLUGIN_METHODS,
  MEMORY_PLUGIN_METHOD_NAMES,
  MEMORY_PROFILE_LIMITS,
  MEMORY_RETRYABLE_ERROR_CODES,
  memoryActorSchema,
  memoryDiagnoseRequestSchema,
  memoryDiagnoseResponseSchema,
  memoryInspectInputSchema,
  memoryInspectRequestSchema,
  memoryInspectResponseSchema,
  memoryInspectResultSchema,
  memoryInspectValueSchema,
  memoryProfileAgentSchema,
  memoryProfileCanonicalText,
  memoryProfileOmittedSchema,
  memoryProfileProjectSchema,
  memoryProfileSinkSchema,
  memoryProfileSyncRequestSchema,
  memoryProfileSyncResponseSchema,
  memoryProfileTeamSchema,
  memoryRememberInputSchema,
  memoryRememberRequestSchema,
  memoryRememberResponseSchema,
  memoryRememberResultSchema,
  memoryRememberValueSchema
};
