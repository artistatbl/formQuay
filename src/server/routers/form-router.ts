import { z } from "zod";
import { j } from "../jstack";
import { db } from "@/lib/db";
import { currentUser } from "@clerk/nextjs/server";
import { HTTPException } from "hono/http-exception";

// Define available form templates
const formTemplates = {
  feedback: {
    name: "Feedback Form",
    description: "Collect user feedback",
    schema: z.object({
      rating: z.number().min(1).max(5),
      feedback: z.string().min(10),
      email: z.string().email().optional(),
    }),
  },
  waitlist: {
    name: "Waitlist Form",
    description: "Collect waitlist signups",
    schema: z.object({
      email: z.string().email(),
      name: z.string().min(2),
      referralSource: z.string().optional(),
    }),
  },
  // Add more templates as needed
} as const;

type FormTemplateType = keyof typeof formTemplates;

export const formRouter = j.router({
  // Get available templates
  getTemplates: j.procedure.query(({ c }) => {
    return c.superjson(
      Object.entries(formTemplates).map(([id, template]) => ({
        id,
        name: template.name,
        description: template.description,
      }))
    );
  }),

  // Create form from template
  createFromTemplate: j.procedure
    .input(z.object({
      templateId: z.enum(['feedback', 'waitlist'] as const),
      name: z.string().optional(),
      description: z.string().optional(),
    }))
    .mutation(async ({ c, input }) => {
      const auth = await currentUser();
      if (!auth) throw new HTTPException(401, { message: "Unauthorized" });

      const user = await db.user.findUnique({
        where: { clerkId: auth.id },
        include: { forms: true }
      });

      if (!user) throw new HTTPException(404, { message: "User not found" });

      // Check form limits based on plan
      const formLimit = user.plan === 'FREE' ? 1 : 
                       user.plan === 'STANDARD' ? 10 : Infinity;
      
      if (user.forms.length >= formLimit) {
        throw new HTTPException(403, { message: "Form limit reached for your plan" });
      }

      const template = formTemplates[input.templateId];
      
      const form = await db.form.create({
        data: {
          name: input.name || template.name,
          description: input.description || template.description,
          schema: template.schema.toString(), // Serialize the schema
          userId: user.id,
        },
      });

      return c.superjson({
        id: form.id,
        name: form.name,
        description: form.description,
      });
    }),

  // Create custom form (existing create endpoint)
  create: j.procedure
    .input(z.object({
      name: z.string(),
      description: z.string().optional(),
      schema: z.string(),
    }))
    .mutation(async ({ c, input }) => {
      // TODO: Implement form creation logic
      return c.superjson({
        id: "temp-id",
        name: input.name,
        description: input.description,
        schema: input.schema,
      });
    }),
});
