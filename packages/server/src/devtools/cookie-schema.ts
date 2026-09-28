import { z } from 'zod';

// One cookie check, for the storage tool and for plan steps.
export const cookieCheckSchema = z
  .object({
    name: z.string().min(1).describe('The cookie name, like "session".'),
    exists: z
      .boolean()
      .optional()
      .describe('false checks that the cookie is gone. The default is true.'),
    value: z
      .string()
      .optional()
      .describe('The exact value. {{secret:NAME}} and {{unique}} work here.'),
    contains: z.string().optional().describe('Text that the value has in it.'),
    httpOnly: z.boolean().optional(),
    secure: z.boolean().optional(),
    sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
  })
  .strict();

export type CookieCheck = z.infer<typeof cookieCheckSchema>;
