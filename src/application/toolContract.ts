import { z } from "zod";

const scope = z.enum(["personal", "project"]);
const kind = z.enum([
  "fact",
  "preference",
  "decision",
  "instruction",
  "context",
]);
const identifier = z.string().min(1).max(200);
const operationId = z.string().min(1).max(128);
const isWellFormed = (value: string): boolean =>
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
    value,
  );
const messageIdentifier = identifier.refine(
  (value) =>
    isWellFormed(value) &&
    value.trim() === value &&
    !/[\x00-\x1f\x7f]/.test(value),
);
const captureMessage = z
  .object({
    id: messageIdentifier,
    role: z.enum(["user", "assistant"]),
    content: z.string().min(1).max(4_000).refine(isWellFormed),
  })
  .strict();
const captureMessages = z
  .array(captureMessage)
  .min(1)
  .max(24)
  .superRefine((messages, context) => {
    if (new Set(messages.map(({ id }) => id)).size !== messages.length) {
      context.addIssue({
        code: "custom",
        message: "Message ids must be unique",
      });
    }
    if (
      messages.reduce((sum, { content }) => sum + content.length, 0) > 20_000
    ) {
      context.addIssue({
        code: "custom",
        message: "Message content exceeds the capture limit",
      });
    }
  });

export const memoryRecallSchema = z
  .object({
    query: z.string().min(1).max(4_000),
    limit: z.number().int().min(1).max(12).optional(),
  })
  .strict();

export const memoryRememberSchema = z
  .object({
    scope,
    content: z.string().min(1).max(4_000),
    kind,
    operationId,
  })
  .strict();

export const memoryCaptureSchema = z
  .object({
    scope,
    messages: captureMessages,
    operationId,
  })
  .strict();

export const memoryInspectSchema = z
  .object({
    scope,
    memoryId: identifier.optional(),
    limit: z.number().int().min(1).max(12).optional(),
    cursor: z.string().min(1).max(8_192).optional(),
  })
  .strict();

export const memoryCorrectSchema = z
  .object({
    scope,
    memoryId: identifier,
    expectedRevision: z.number().int().positive(),
    content: z.string().min(1).max(4_000),
    kind,
    operationId,
  })
  .strict();

export const memoryForgetSchema = z
  .object({
    scope,
    memoryId: identifier,
    expectedRevision: z.number().int().positive(),
    operationId,
  })
  .strict();

export const MEMORY_TOOL_CONTRACT = {
  memory_recall: {
    schema: memoryRecallSchema,
  },
  memory_remember: {
    schema: memoryRememberSchema,
  },
  memory_capture: {
    schema: memoryCaptureSchema,
  },
  memory_inspect: {
    schema: memoryInspectSchema,
  },
  memory_correct: {
    schema: memoryCorrectSchema,
  },
  memory_forget: {
    schema: memoryForgetSchema,
  },
} as const;

export type MemoryToolName = keyof typeof MEMORY_TOOL_CONTRACT;
export type MemoryRecallInput = z.infer<typeof memoryRecallSchema>;
export type MemoryRememberInput = z.infer<typeof memoryRememberSchema>;
export type MemoryCaptureInput = z.infer<typeof memoryCaptureSchema>;
export type MemoryInspectInput = z.infer<typeof memoryInspectSchema>;
export type MemoryCorrectInput = z.infer<typeof memoryCorrectSchema>;
export type MemoryForgetInput = z.infer<typeof memoryForgetSchema>;
