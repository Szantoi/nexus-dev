// Input Validation Schemas with Zod
// Security hardening for all API endpoints

import { z, ZodError, ZodIssue } from 'zod';
import { Request, Response, NextFunction } from 'express';
import { getAllNamesAndAliases, resolveTerminal } from './terminalConfig';

// ─── Common Schemas ─────────────────────────────────────────────────────────

// Dynamic terminal validation using terminalConfig
// Accepts any valid terminal name or alias from config
export const TerminalSchema = z.string().refine(
  (val) => resolveTerminal(val) !== null,
  { message: 'Invalid terminal name or alias' }
).transform((val) => resolveTerminal(val)!);  // Transform to canonical name

export const MessageTypeSchema = z.enum(['task', 'question', 'done', 'blocked']);

export const PrioritySchema = z.enum(['critical', 'high', 'medium', 'low']);

export const StatusSchema = z.enum(['UNREAD', 'READ', 'all']);

export const ModelSchema = z.enum(['haiku', 'sonnet', 'opus']);

// ─── API Schemas ────────────────────────────────────────────────────────────

// POST /api/knowledge/search
export const SearchBodySchema = z.object({
  q: z.string()
    .min(1, 'Query cannot be empty')
    .max(1000, 'Query too long (max 1000 chars)'),
  topK: z.number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(5),
});

// GET /api/knowledge/search
export const SearchQuerySchema = z.object({
  q: z.string()
    .min(1, 'Query cannot be empty')
    .max(1000, 'Query too long'),
  topK: z.string()
    .regex(/^\d+$/, 'topK must be a number')
    .transform(Number)
    .pipe(z.number().int().min(1).max(50))
    .optional(),
});

// POST /api/mailbox/:terminal/inbox (send_message)
export const SendMessageSchema = z.object({
  to: TerminalSchema,
  type: MessageTypeSchema,
  priority: PrioritySchema.optional().default('medium'),
  subject: z.string()
    .min(1, 'Subject required')
    .max(200, 'Subject too long'),
  body: z.string()
    .min(1, 'Body required')
    .max(50000, 'Body too long (max 50KB)'),
  ref: z.string()
    .regex(/^MSG-[A-Z]+-\d+$/, 'Invalid ref format')
    .optional(),
  model: ModelSchema.optional(),
});

// POST /api/mailbox/:terminal/outbox (submit_done)
export const SubmitDoneSchema = z.object({
  ref: z.string()
    .regex(/^MSG-[A-Z]+-\d+$/, 'Invalid ref format (expected MSG-XXX-NNN)'),
  summary: z.string()
    .min(10, 'Summary too short')
    .max(5000, 'Summary too long'),
  files_changed: z.array(z.string().max(500)).optional(),
  tests_passed: z.boolean().optional(),
  notes: z.string().max(10000).optional(),
});

// GET /api/mailbox/:terminal/inbox
export const InboxQuerySchema = z.object({
  status: StatusSchema.optional().default('UNREAD'),
});

// GET /api/tasks/status
export const TaskStatusQuerySchema = z.object({
  task_id: z.string()
    .regex(/^MSG-[A-Z]+-\d+$/, 'Invalid task_id format'),
});

// Terminal path param
export const TerminalParamSchema = z.object({
  terminal: TerminalSchema,
});

// ─── Validation Middleware ──────────────────────────────────────────────────

type ValidationTarget = 'body' | 'query' | 'params';

export function validate<T extends z.ZodSchema>(
  schema: T,
  target: ValidationTarget = 'body'
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const data = target === 'body' ? req.body
               : target === 'query' ? req.query
               : req.params;

    const result = schema.safeParse(data);

    if (!result.success) {
      const errors = result.error.issues.map((e: ZodIssue) => ({
        path: e.path.join('.'),
        message: e.message,
      }));

      res.status(400).json({
        error: 'Validation failed',
        details: errors,
      });
      return;
    }

    // Replace with validated/transformed data
    if (target === 'body') {
      req.body = result.data;
    } else if (target === 'query') {
      (req as any).validatedQuery = result.data;
    } else {
      (req as any).validatedParams = result.data;
    }

    next();
  };
}

// ─── Sanitization Helpers ───────────────────────────────────────────────────

export function sanitizeFilename(filename: string): string {
  // Remove path traversal attempts and dangerous characters
  return filename
    .replace(/\.\./g, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .slice(0, 255);
}

export function sanitizeMarkdown(content: string): string {
  // Basic XSS prevention for markdown content
  return content
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '');
}
