import { z } from "zod";
import { j, privateProcedure } from "../jstack";
import { db } from "@/lib/db";
import { currentUser } from "@clerk/nextjs/server";
import { HTTPException } from "hono/http-exception";
import { User, NotificationStatus, NotificationType } from "@prisma/client";
import { getQuotaByPlan } from "@/config/usage";
import { startOfMonth } from "date-fns";
import { Resend } from 'resend';
import { FormSubmissionEmail } from '@/emails/form-submission';
import { render } from '@react-email/components';
import { Prisma } from "@prisma/client";
import { enhanceDataWithAnalytics, extractAnalyticsFromSubmissions } from "@/lib/analytics-utils";
import { exportFormSubmissions } from "@/services/export-service";
import { ratelimitConfig } from "@/lib/ratelimiter";

const resend = new Resend(process.env.RESEND_API_KEY);

interface EmailSettings {
  enabled: boolean;
  fromEmail?: string;
  subject?: string;
  template?: string;
  replyTo?: string;
  // Developer notification settings
  developerNotificationsEnabled?: boolean;
  developerEmail?: string;
  maxNotificationsPerHour?: number;
  notificationConditions?: any;
  lastNotificationSentAt?: Date;
}

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
  contact: {
    name: "Contact Form",
    description: "Simple contact form for inquiries",
    schema: z.object({
      name: z.string().min(2),
      email: z.string().email(),
      message: z.string().min(10),
    }),
  },
  // Add more templates as needed
} as const;

type FormTemplateType = 'feedback' | 'waitlist' | 'contact';

export const formRouter = j.router({
  // Get all forms created by the authenticated user
  getUserForms: privateProcedure
    .input(z.object({
      limit: z.number().min(1).max(100).default(10),
      cursor: z.string().optional(),
    }).optional())
    .query(async ({ c, input, ctx }) => {
      if (!ctx.user) {
        throw new HTTPException(401, { message: "User not authenticated" });
      }
      
      // Get forms with pagination
      const take = input?.limit ?? 10;
      const cursor = input?.cursor;
      
      const forms = await db.form.findMany({
        where: { userId: ctx.user.id },
        take: take + 1, // Get one extra to determine if there's a next page
        cursor: cursor ? { id: cursor } : undefined,
        orderBy: { createdAt: 'desc' },
        include: {
          _count: {
            select: { submissions: true }
          }
        }
      });
      
      // Check if we have more results
      const hasMore = forms.length > take;
      const data = hasMore ? forms.slice(0, take) : forms;
      
      return c.superjson({
        forms: data.map(form => ({
          id: form.id,
          name: form.name,
          description: form.description,
          submissionCount: form._count.submissions,
          createdAt: form.createdAt,
          updatedAt: form.updatedAt,
        })),
        nextCursor: hasMore && data.length > 0 ? data[data.length - 1]?.id : undefined,
      });
    }),

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
  createFromTemplate: privateProcedure
    .input(z.object({
      templateId: z.enum(['feedback', 'waitlist', 'contact'] as const),
      name: z.string().optional(),
      description: z.string().optional(),
    }))
    .mutation(async ({ c, input, ctx }) => {
      const { user } = ctx;
      if (!user) throw new HTTPException(401, { message: "Unauthorized" });

      // Get user with plan
      const userWithPlan = await db.user.findUnique({
        where: { id: user.id },
        select: { 
          plan: true,
          id: true
        }
      });

      if (!userWithPlan) throw new HTTPException(404, { message: "User not found" });

      // Get form count
      const formCount = await db.form.count({
        where: { userId: user.id }
      });

      // Check form limits based on plan
      const quota = getQuotaByPlan(userWithPlan.plan);
      
      if (formCount >= quota.maxForms) {
        throw new HTTPException(403, { 
          message: `Form limit reached (${formCount}/${quota.maxForms}) for your plan`
        });
      }

      const template = formTemplates[input.templateId];
      
      const form = await db.form.create({
        data: {
          name: input.name || template.name,
          description: input.description || template.description,
          schema: template.schema.toString(), // Serialize the schema
          userId: userWithPlan.id,
          emailSettings: {
            create: {
              enabled: false
            }
          }
        },
      });

      return c.superjson({
        id: form.id,
        name: form.name,
        description: form.description,
      });
    }),

  // Create custom form (existing create endpoint)
  create: privateProcedure
    .input(z.object({
      name: z.string(),
      description: z.string().optional(),
      schema: z.string(),
    }))
    .mutation(async ({ c, input, ctx }) => {
      const { user } = ctx;
      if (!user) throw new HTTPException(401, { message: "Unauthorized" });

      // Get user with plan
      const userWithPlan = await db.user.findUnique({
        where: { id: user.id },
        select: { 
          plan: true,
          id: true
        }
      });

      if (!userWithPlan) throw new HTTPException(404, { message: "User not found" });

      // Get form count
      const formCount = await db.form.count({
        where: { userId: user.id }
      });

      // Check form limits based on plan
      const quota = getQuotaByPlan(userWithPlan.plan);
      
      if (formCount >= quota.maxForms) {
        throw new HTTPException(403, { 
          message: `Form limit reached (${formCount}/${quota.maxForms}) for your plan`
        });
      }
      
      const form = await db.form.create({
        data: {
          name: input.name,
          description: input.description,
          schema: input.schema,
          userId: userWithPlan.id,
          emailSettings: {
            create: {
              enabled: false,
              fromEmail: process.env.RESEND_FROM_EMAIL || 'contact@mantlz.app',
              subject: `Form Submission Confirmation - ${input.name}`,
              template: `
                <h1>Thank you for your submission!</h1>
                <p>We have received your submission for the form "${input.name}".</p>
                <p>We will review your submission and get back to you soon.</p>
              `.trim(),
            }
          }
        },
      });

      return c.superjson({
        id: form.id,
        name: form.name,
        description: form.description,
        schema: form.schema,
      });
    }),

  // Get form by ID
  getFormById: privateProcedure
    .input(z.object({
      id: z.string(),
    }))
    .query(async ({ c, input, ctx }) => {
      const { id } = input;
      const userId = ctx.user.id;
      
      const form = await db.form.findUnique({
        where: {
          id,
          userId,
        },
        include: {
          _count: {
            select: {
              submissions: true,
            },
          },
          emailSettings: true,
        },
      });
      
      if (!form) {
        throw new Error('Form not found');
      }
      
      return c.superjson({
        id: form.id,
        name: form.name,
        description: form.description,
        createdAt: form.createdAt,
        updatedAt: form.updatedAt,
        submissionCount: form._count.submissions,
        emailSettings: form.emailSettings || { enabled: false, fromEmail: process.env.RESEND_FROM_EMAIL || 'contact@mantlz.app' },
      });
    }),
    
  // Get form submissions
  getFormSubmissions: privateProcedure
    .input(z.object({
      formId: z.string(),
    }))
    .query(async ({ c, ctx, input }) => {
      const { formId } = input;
      const userId = ctx.user.id;
      
      // Verify form ownership
      const form = await db.form.findUnique({
        where: {
          id: formId,
          userId,
        },
        include: {
          user: {
            select: {
              id: true,
              plan: true,
              email: true
            }
          },
          emailSettings: true
        }
      });
      
      if (!form) {
        throw new Error('Form not found');
      }
      
      const submissions = await db.submission.findMany({
        where: {
          formId,
        },
        orderBy: {
          createdAt: 'desc',
        },
        select: {
          id: true,
          createdAt: true,
          data: true,
        },
      });
      
      return c.superjson({
        submissions,
      });
    }),

  // Get form analytics data
  getFormAnalytics: privateProcedure
    .input(z.object({
      formId: z.string(),
      timeRange: z.enum(['day', 'week', 'month']).default('day'),
    }))
    .query(async ({ c, ctx, input }) => {
      const { formId, timeRange } = input;
      const userId = ctx.user.id;
      
      // Verify form ownership
      const form = await db.form.findUnique({
        where: {
          id: formId,
          userId,
        },
        include: {
          user: {
            select: {
              id: true,
              plan: true
            }
          }
        }
      });
      
      if (!form) {
        throw new Error('Form not found');
      }

      // Get user plan
      const userPlan = form.user.plan;
      
      // Get all submissions for this form
      const submissions = await db.submission.findMany({
        where: { formId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          createdAt: true,
          data: true,
          email: true,
        }
      });
      
      const now = new Date();
      const formCreatedAt = new Date(form.createdAt);
      
      // Calculate daily submission rate
      const daysSinceCreation = Math.max(1, (now.getTime() - formCreatedAt.getTime()) / (1000 * 60 * 60 * 24));
      const dailySubmissionRate = submissions.length / daysSinceCreation;
      
      // Calculate week-over-week growth
      const oneWeekAgo = new Date(now);
      oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
      const twoWeeksAgo = new Date(now);
      twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
      
      const lastWeekSubmissions = submissions.filter(sub => 
        new Date(sub.createdAt) >= oneWeekAgo
      );
      const previousWeekSubmissions = submissions.filter(sub => 
        new Date(sub.createdAt) >= twoWeeksAgo && new Date(sub.createdAt) < oneWeekAgo
      );
      
      const weekOverWeekGrowth = previousWeekSubmissions.length === 0
        ? lastWeekSubmissions.length > 0 ? 1 : 0
        : (lastWeekSubmissions.length - previousWeekSubmissions.length) / previousWeekSubmissions.length;
      
      // Calculate last 24 hours submissions
      const oneDayAgo = new Date(now);
      oneDayAgo.setDate(oneDayAgo.getDate() - 1);
      const last24HoursSubmissions = submissions.filter(sub => 
        new Date(sub.createdAt) >= oneDayAgo
      );
      
      // Calculate engagement score
      const engagementScore = Math.min(10, submissions.length / 10);
      
      // Peak hour calculation
      const submissionHours = submissions.map(sub => new Date(sub.createdAt).getHours());
      const hourCounts = submissionHours.reduce((acc, hour) => {
        acc[hour] = (acc[hour] || 0) + 1;
        return acc;
      }, {} as Record<number, number>);
      
      const peakHour = Object.entries(hourCounts).reduce((max, [hour, count]) => 
        count > (hourCounts[parseInt(max[0])] || 0) ? [hour, count] : max
      , ['0', 0])[0];
      
      // Calculate completion rate based on actual form abandonment data
      const abandonedSubmissions = submissions.filter(sub => {
        const data = sub.data as any;
        return data?.isAbandoned === true;
      });
      
      const completionRate = submissions.length > 0 
        ? (submissions.length - abandonedSubmissions.length) / submissions.length 
        : 0.9; // Default if no submissions
      
      // Calculate average response time between submissions
      const sortedSubmissions = [...submissions].sort((a, b) => 
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
      
      // Calculate time differences between consecutive submissions
      const responseTimes = sortedSubmissions.slice(1).map((sub, i) => {
        const currentTime = new Date(sub.createdAt).getTime();
        const previousTime = new Date(sortedSubmissions[i]!.createdAt).getTime();
        return currentTime - previousTime;
      });
      
      // Calculate average response time in minutes
      // Filter out any unreasonable gaps (e.g., > 24 hours) to avoid skewing the average
      const reasonableResponseTimes = responseTimes.filter(time => 
        time <= 24 * 60 * 60 * 1000 // 24 hours in milliseconds
      );
      
      const avgResponseTime = reasonableResponseTimes.length > 0
        ? reasonableResponseTimes.reduce((a, b) => a + b, 0) / reasonableResponseTimes.length
        : 150000; // Default 2.5 minutes if no submissions
      
      // Convert to minutes and round to 1 decimal place
      const avgResponseTimeInMinutes = Math.round((avgResponseTime / (1000 * 60)) * 10) / 10;
      
      // Generate time series data
      interface TimeSeriesPoint {
        time: string;
        submissions: number;
      }
      
      let timeSeriesData: TimeSeriesPoint[] = [];
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      
      if (timeRange === 'day') {
        // Hourly data for the last 24 hours
        for (let i = 0; i < 24; i++) {
          const hour = new Date(now);
          hour.setHours(now.getHours() - 23 + i);
          hour.setMinutes(0, 0, 0);
          
          const nextHour = new Date(hour);
          nextHour.setHours(hour.getHours() + 1);
          
          const hourSubmissions = submissions.filter(sub => {
            const subDate = new Date(sub.createdAt);
            return subDate >= hour && subDate < nextHour;
          });
          
          timeSeriesData.push({
            time: `${hour.getHours()}:00`,
            submissions: hourSubmissions.length,
          });
        }
      } else if (timeRange === 'week') {
        // Daily data for the last 7 days
        for (let i = 0; i < 7; i++) {
          const day = new Date(now);
          day.setDate(day.getDate() - 6 + i);
          day.setHours(0, 0, 0, 0);
          
          const nextDay = new Date(day);
          nextDay.setDate(day.getDate() + 1);
          
          const daySubmissions = submissions.filter(sub => {
            const subDate = new Date(sub.createdAt);
            return subDate >= day && subDate < nextDay;
          });
          
          timeSeriesData.push({
            time: dayNames[day.getDay() % 7] || '',
            submissions: daySubmissions.length,
          });
        }
      } else if (timeRange === 'month') {
        // Daily data for the last 30 days
        for (let i = 0; i < 30; i++) {
          const day = new Date(now);
          day.setDate(day.getDate() - 29 + i);
          day.setHours(0, 0, 0, 0);
          
          const nextDay = new Date(day);
          nextDay.setDate(day.getDate() + 1);
          
          const daySubmissions = submissions.filter(sub => {
            const subDate = new Date(sub.createdAt);
            return subDate >= day && subDate < nextDay;
          });
          
          timeSeriesData.push({
            time: `${day.getMonth() + 1}/${day.getDate()}`,
            submissions: daySubmissions.length,
          });
        }
      }
      
      // Latest data point
      let latestDataPoint: TimeSeriesPoint = { time: '', submissions: 0 };
      if (timeSeriesData.length > 0) {
        const lastItem = timeSeriesData[timeSeriesData.length - 1];
        if (lastItem) {
          latestDataPoint = {
            time: lastItem.time,
            submissions: lastItem.submissions
          };
        }
      }
      
      // Use our utility function to extract browser and location stats
      const { browserStats, locationStats } = extractAnalyticsFromSubmissions(submissions);
      
      // Empty user insights array (we're not using this anymore)
      const userInsights: any[] = [];
      
      return c.superjson({
        totalSubmissions: submissions.length,
        dailySubmissionRate,
        weekOverWeekGrowth,
        last24HoursSubmissions: last24HoursSubmissions.length,
        engagementScore,
        peakSubmissionHour: parseInt(peakHour),
        completionRate,
        averageResponseTime: avgResponseTimeInMinutes,
        timeSeriesData,
        latestDataPoint,
        timeRange,
        userPlan,
        userInsights,
        browserStats,
        locationStats,
      });
    }),

  // Submit form
  submit: privateProcedure
    .input(z.object({
      formId: z.string(),
      data: z.record(z.any())
    }))
    .mutation(async ({ c, input, ctx }) => {
      const { formId, data } = input;
      
      // Get the form to validate the submission
      const form = await db.form.findUnique({
        where: { id: formId },
        include: {
          user: {
            select: {
              id: true,
              plan: true,
              email: true
            }
          },
          emailSettings: true
        }
      });
      
      if (!form) {
        throw new HTTPException(404, { message: 'Form not found' });
      }

      // Check if user has reached their monthly submission limit
      const currentDate = startOfMonth(new Date());
      
      // Count the submissions for the current month for all user forms
      const monthlySubmissionsCount = await db.submission.count({
        where: {
          form: {
            userId: form.user.id
          },
          createdAt: {
            gte: currentDate
          }
        }
      });
      
      // Get the quota for the user's plan
      const quota = getQuotaByPlan(form.user.plan);
      
      if (monthlySubmissionsCount >= quota.maxSubmissionsPerMonth) {
        throw new HTTPException(403, { 
          message: `Monthly submission limit reached (${monthlySubmissionsCount}/${quota.maxSubmissionsPerMonth}) for this plan`
        });
      }
      
      // Use our utility function to enhance data with analytics info
      const enhancedData = enhanceDataWithAnalytics(data, {
        userAgent: c.req.header('user-agent'),
        cfCountry: c.req.header('cf-ipcountry'),
        acceptLanguage: c.req.header('accept-language'),
        ip: c.req.header('x-forwarded-for')
      });
      
      // Create the submission
      const submission = await db.submission.create({
        data: {
          formId,
          data: enhancedData,
          email: data.email, // Store email if provided in form
        },
      });

      // Send confirmation email for STANDARD and PRO users
      if (
        (form.user.plan === 'STANDARD' || form.user.plan === 'PRO') && 
        (form.emailSettings as unknown as EmailSettings)?.enabled &&
        data.email && 
        typeof data.email === 'string'
      ) {
        try {
          const htmlContent = await render(
            FormSubmissionEmail({
              formName: form.name,
              submissionData: data,
            })
          );

          await resend.emails.send({
            from: (form.emailSettings as unknown as EmailSettings)?.fromEmail || 'contact@mantlz.app',
            to: data.email,
            subject: (form.emailSettings as unknown as EmailSettings)?.subject || `Confirmation: ${form.name} Submission`,
            replyTo: 'contact@mantlz.app',
            html: htmlContent,
          });

          // Create notification log for successful email
          await db.notificationLog.create({
            data: {
              type: 'SUBMISSION_CONFIRMATION',
              status: 'SENT',
              submissionId: submission.id,
              formId: form.id,
            },
          });
        } catch (error) {
          // Log error and create notification log for failed email
          console.error('Failed to send confirmation email:', error);
          await db.notificationLog.create({
            data: {
              type: 'SUBMISSION_CONFIRMATION',
              status: 'FAILED',
              error: error instanceof Error ? error.message : 'Unknown error',
              submissionId: submission.id,
              formId: form.id,
            },
          });
        }
      } else {
        // Create a SKIPPED notification log if email was not sent
        await db.notificationLog.create({
          data: {
            type: 'SUBMISSION_CONFIRMATION',
            status: 'SKIPPED',
            error: 'Email not sent - plan or settings not configured',
            submissionId: submission.id,
            formId: form.id,
          },
        });
      }

      return c.superjson({
        id: submission.id,
        message: 'Form submitted successfully'
      });
    }),

  // Add this new procedure
  toggleEmailSettings: privateProcedure
    .input(z.object({
      formId: z.string(),
      enabled: z.boolean(),
      // Add new fields for developer notifications
      developerNotifications: z.object({
        enabled: z.boolean(),
        digestFrequency: z.enum(['realtime', 'hourly', 'daily', 'weekly']),
        // Notification conditions
        conditions: z.array(z.object({
          field: z.string(),
          operator: z.enum(['equals', 'contains', 'greaterThan', 'lessThan']),
          value: z.string()
        })).optional(),
        maxNotificationsPerHour: z.number().min(1).max(100).default(10),
      }).optional(),
    }))
    .mutation(async ({ c, input, ctx }) => {
      const { formId, enabled } = input;
      
      const form = await db.form.update({
        where: {
          id: formId,
          userId: ctx.user.id, // Ensure user owns the form
        },
        data: {
          emailSettings: {
            update: {
              enabled,
            }
          }
        },
      });

      return c.superjson({ success: true });
    }),

  delete: privateProcedure
    .input(z.object({
      formId: z.string()
    }))
    .mutation(async ({ c, input, ctx }) => {
      const { formId } = input;

      try {
        // First verify the user owns this form
        const form = await db.form.findFirst({
          where: {
            id: formId,
            userId: ctx.user.id,
          },
        });

        if (!form) {
          throw new Error('Form not found or you do not have permission to delete it');
        }

        // Delete everything in a transaction to ensure data consistency
        await db.$transaction([
          // 1. Delete notification logs first (they reference both form and submissions)
          db.notificationLog.deleteMany({
            where: { formId }
          }),

          // 2. Delete submissions
          db.submission.deleteMany({
            where: { formId }
          }),

          // 3. Delete email settings
          db.emailSettings.deleteMany({
            where: { formId }
          }),

          // 4. Finally delete the form itself
          db.form.delete({
            where: {
              id: formId,
              userId: ctx.user.id,
            },
          })
        ]);

        return c.superjson({ success: true });
      } catch (error) {
        console.error('Error deleting form:', error);
        
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
          throw new Error(`Database error: ${error.message}`);
        }
        
        throw new Error('Failed to delete form and its related data');
      }
    }),

  // Delete a single submission
  deleteSubmission: privateProcedure
    .input(z.object({
      submissionId: z.string()
    }))
    .mutation(async ({ c, input, ctx }) => {
      const { submissionId } = input;
      const userId = ctx.user.id;

      try {
        // First get the submission to verify ownership
        const submission = await db.submission.findUnique({
          where: { id: submissionId },
          include: {
            form: {
              select: {
                userId: true
              }
            }
          }
        });

        if (!submission) {
          throw new HTTPException(404, { message: 'Submission not found' });
        }

        // Check if the user owns the form associated with this submission
        if (submission.form.userId !== userId) {
          throw new HTTPException(403, { message: 'You do not have permission to delete this submission' });
        }

        // Delete notifications first, then the submission
        await db.notificationLog.deleteMany({
          where: { submissionId }
        });

        await db.submission.delete({
          where: { id: submissionId }
        });

        return c.superjson({ success: true });
      } catch (error) {
        console.error('Error deleting submission:', error);
        if (error instanceof HTTPException) {
          throw error;
        }
        throw new HTTPException(500, { message: 'Failed to delete submission' });
      }
    }),

  // Get email settings for a form
  getEmailSettings: privateProcedure
    .input(z.object({
      formId: z.string(),
    }))
    .query(async ({ c, input, ctx }) => {
      const { formId } = input;
      const userId = ctx.user.id;
      
      // First verify the user owns this form
      const form = await db.form.findFirst({
        where: {
          id: formId,
          userId, // Ensure user owns the form
        },
        include: {
          emailSettings: true,
        }
      });

      if (!form) {
        throw new HTTPException(404, { message: 'Form not found or you do not have permission to access it' });
      }

      return c.superjson(form.emailSettings || {
        id: '',
        formId,
        enabled: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        fromEmail: null,
        subject: null,
        template: null,
        replyTo: null,
        developerNotificationsEnabled: false,
        developerEmail: null,
        maxNotificationsPerHour: 10,
        notificationConditions: null,
        lastNotificationSentAt: null,
      });
    }),

  // Update email settings for a form
  updateEmailSettings: privateProcedure
    .input(z.object({
      formId: z.string(),
      developerNotificationsEnabled: z.boolean().optional(),
      maxNotificationsPerHour: z.number().min(1).max(100).optional(),
    }))
    .mutation(async ({ c, input, ctx }) => {
      const { formId, ...settings } = input;
      const userId = ctx.user.id;
      
      try {
        // If formId is 'global', update user's global settings
        if (formId === 'global') {
          const globalSettings = await db.globalSettings.upsert({
            where: {
              userId,
            },
            update: {
              developerNotificationsEnabled: settings.developerNotificationsEnabled,
              maxNotificationsPerHour: settings.maxNotificationsPerHour,
            },
            create: {
              userId,
              developerNotificationsEnabled: settings.developerNotificationsEnabled ?? false,
              maxNotificationsPerHour: settings.maxNotificationsPerHour ?? 10,
            },
          });

          return c.superjson({ 
            success: true, 
            data: {
              developerNotificationsEnabled: globalSettings.developerNotificationsEnabled,
              maxNotificationsPerHour: globalSettings.maxNotificationsPerHour,
            }
          });
        }

        // Otherwise, update form-specific settings
        const emailSettings = await db.emailSettings.upsert({
          where: {
            formId,
          },
          update: {
            developerNotificationsEnabled: settings.developerNotificationsEnabled,
            maxNotificationsPerHour: settings.maxNotificationsPerHour,
          },
          create: {
            formId,
            enabled: false,
            developerNotificationsEnabled: settings.developerNotificationsEnabled ?? false,
            maxNotificationsPerHour: settings.maxNotificationsPerHour ?? 10,
          },
        });

        return c.superjson({ success: true, data: emailSettings });
      } catch (error) {
        console.error('Error updating email settings:', error);
        throw new HTTPException(500, { message: 'Failed to update email settings' });
      }
    }),

  // Get global settings for the user
  getGlobalSettings: privateProcedure
    .query(async ({ c, ctx }) => {
      const userId = ctx.user.id;
      
      const globalSettings = await db.globalSettings.findUnique({
        where: { userId }
      });

      return c.superjson(globalSettings || {
        developerNotificationsEnabled: false,
        maxNotificationsPerHour: 10,
      });
    }),

  // Update global settings for the user
  updateGlobalSettings: privateProcedure
    .input(z.object({
      developerNotificationsEnabled: z.boolean().optional(),
      maxNotificationsPerHour: z.number().min(1).max(100).optional(),
    }))
    .mutation(async ({ c, input, ctx }) => {
      const userId = ctx.user.id;
      
      try {
        // Get user with plan
        const user = await db.user.findUnique({
          where: { id: userId },
          select: { plan: true }
        });

        if (!user) {
          throw new HTTPException(404, { message: 'User not found' });
        }

        // Only PRO users can modify notification settings
        if (user.plan !== 'PRO') {
          throw new HTTPException(403, { 
            message: 'You need to be on the PRO plan to modify notification settings' 
          });
        }

        const globalSettings = await db.globalSettings.upsert({
          where: { userId },
          update: {
            developerNotificationsEnabled: input.developerNotificationsEnabled,
            maxNotificationsPerHour: input.maxNotificationsPerHour,
          },
          create: {
            userId,
            developerNotificationsEnabled: input.developerNotificationsEnabled ?? false,
            maxNotificationsPerHour: input.maxNotificationsPerHour ?? 10,
          },
        });

        return c.superjson({ 
          success: true, 
          data: {
            developerNotificationsEnabled: globalSettings.developerNotificationsEnabled,
            maxNotificationsPerHour: globalSettings.maxNotificationsPerHour,
          }
        });
      } catch (error) {
        console.error('Error updating global settings:', error);
        if (error instanceof HTTPException) {
          throw error;
        }
        throw new HTTPException(500, { message: 'Failed to update global settings' });
      }
    }),

  getSubmissionLogs: privateProcedure
    .input(z.object({
      formId: z.string().optional(),
      page: z.number().default(1),
      limit: z.number().default(10),
      status: z.string().optional(),
      type: z.string().optional(),
      search: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    }))
    .query(async ({ ctx, c, input }) => {
      const { user } = ctx;
      if (!user) {
        throw new HTTPException(401, { message: "User not authenticated" });
      }

      const { formId, page, limit, status, type, search, startDate, endDate } = input;
      const skip = (page - 1) * limit;

      try {
        console.log('🔍 Starting getSubmissionLogs query:', { formId, page, limit, status, type, search, startDate, endDate });

        // Get user's plan
        const userWithPlan = await db.user.findUnique({
          where: { id: user.id },
          select: { plan: true }
        });

        if (!userWithPlan) {
          throw new HTTPException(404, { message: "User not found" });
        }

        // Check if date filtering is requested but user isn't on PRO plan
        if ((startDate || endDate) && userWithPlan.plan !== 'PRO') {
          throw new HTTPException(403, { 
            message: "Date filtering is only available with the PRO plan" 
          });
        }

        // Build the where clause for submissions
        const where: any = {
          form: {
            userId: user.id,
          },
          ...(formId ? { formId } : {}),
          ...(search ? {
            OR: [
              { id: { contains: search, mode: 'insensitive' as const } },
              { email: { contains: search, mode: 'insensitive' as const } },
              { data: { path: ['$.email'], string_contains: search, mode: 'insensitive' as const } },
            ]
          } : {}),
        };

        // Add date range filtering only for PRO users
        if ((startDate || endDate) && userWithPlan.plan === 'PRO') {
          where.createdAt = {};
          
          if (startDate) {
            where.createdAt.gte = new Date(startDate);
          }
          
          if (endDate) {
            // Add one day to endDate to include the full day
            const endDateObj = new Date(endDate);
            endDateObj.setDate(endDateObj.getDate() + 1);
            where.createdAt.lt = endDateObj;
          }
        }

        // Build the where clause for notification logs
        const notificationLogsWhere: any = {
          ...(status ? { status: status as NotificationStatus } : {}),
          ...(type ? { type: type as NotificationType } : {}),
        };

        console.log('📝 Query where clause:', where);

        const [submissions, total] = await Promise.all([
          db.submission.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: limit,
            skip,
            select: {
              id: true,
              createdAt: true,
              email: true,
              data: true,
              form: {
                select: {
                  id: true,
                  name: true,
                  emailSettings: {
                    select: {
                      enabled: true,
                      developerNotificationsEnabled: true,
                    }
                  }
                }
              },
              notificationLogs: {
                where: notificationLogsWhere,
                select: {
                  id: true,
                  type: true,
                  status: true,
                  error: true,
                  createdAt: true,
                },
                orderBy: { createdAt: 'desc' }
              }
            }
          }),
          db.submission.count({ where })
        ]);

        // Enhance submissions with analytics data and format notification logs
        const enhancedSubmissions = submissions.map(submission => {
          const data = submission.data as any;
          const meta = data?._meta || {};
          
          // Format notification logs to ensure consistent structure
          const formattedLogs = submission.notificationLogs.map(log => ({
            ...log,
            createdAt: log.createdAt.toISOString(),
            type: log.type as NotificationType,
            status: log.status as NotificationStatus,
            error: log.error || null
          }));

          // Add default notification logs if they don't exist
          const hasUserEmailLog = formattedLogs.some(log => log.type === 'SUBMISSION_CONFIRMATION');
          const hasDevEmailLog = formattedLogs.some(log => log.type === 'DEVELOPER_NOTIFICATION');

          // Only add default logs if there are no logs of that type
          if (!hasUserEmailLog && submission.email) {
            formattedLogs.push({
              id: `temp-${submission.id}-user-email`,
              type: 'SUBMISSION_CONFIRMATION' as NotificationType,
              status: 'SKIPPED' as NotificationStatus,
              error: 'Email not sent - plan or settings not configured',
              createdAt: submission.createdAt.toISOString()
            });
          }

          // Add developer email log if it doesn't exist and developer notifications are enabled
          if (!hasDevEmailLog) {
            formattedLogs.push({
              id: `temp-${submission.id}-dev-email`,
              type: 'DEVELOPER_NOTIFICATION' as NotificationType,
              status: submission.form.emailSettings?.developerNotificationsEnabled ? 'SKIPPED' as NotificationStatus : 'FAILED' as NotificationStatus,
              error: submission.form.emailSettings?.developerNotificationsEnabled 
                ? 'Developer notification not sent' 
                : 'Developer notifications are disabled',
              createdAt: submission.createdAt.toISOString()
            });
          }

          // Sort logs by type and creation date
          formattedLogs.sort((a, b) => {
            if (a.type === b.type) {
              return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
            }
            return a.type.localeCompare(b.type);
          });
          
          return {
            ...submission,
            analytics: {
              browser: meta.browser || 'Unknown',
              location: meta.country || 'Unknown',
            },
            notificationLogs: formattedLogs
          };
        });

        console.log('✅ Found submissions:', { count: submissions.length, total });

        return c.superjson({
          submissions: enhancedSubmissions,
          pagination: {
            total,
            pages: Math.ceil(total / limit),
            currentPage: page,
          }
        });
      } catch (error) {
        console.error('❌ Error in getSubmissionLogs:', error);
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
          console.error('Prisma error details:', {
            code: error.code,
            meta: error.meta,
            message: error.message
          });
        }
        throw new HTTPException(500, { 
          message: error instanceof Error ? error.message : 'Failed to fetch submission logs'
        });
      }
    }),

  export: privateProcedure
    .input(z.object({
      formId: z.string(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    }))
    .mutation(async ({ c, input, ctx }) => {
      const { formId, startDate, endDate } = input;

      // Verify form ownership
      const form = await db.form.findFirst({
        where: {
          id: formId,
          userId: ctx.user.id,
        },
      });

      if (!form) {
        throw new HTTPException(404, { message: "Form not found" });
      }

      const result = await exportFormSubmissions({
        formId,
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
      });

      return c.json(result);
    }),

  // New endpoint for searching submissions
  searchSubmissions: privateProcedure
    .input(z.object({
      query: z.string(),
      formId: z.string().optional()
    }))
    .query(async ({ c, ctx, input }) => {
      const { user } = ctx;
      if (!user) {
        throw new HTTPException(401, { message: "User not authenticated" });
      }

      // Verify user is premium
      const userWithPlan = await db.user.findUnique({
        where: { id: user.id },
        select: { plan: true }
      });

      if (!userWithPlan || (userWithPlan.plan !== 'PRO' && userWithPlan.plan !== 'STANDARD')) {
        throw new HTTPException(403, { message: "Premium feature" });
      }

      const { query, formId } = input;
      
      // Check if query follows the @id format
      const isIdSearch = query.startsWith('@');
      const searchValue = isIdSearch ? query.substring(1) : query;

      // Build the where clause based on search type and optional formId
      const whereClause: any = {
        form: {
          userId: user.id
        }
      };
      
      // Add formId to the query if specified
      if (formId) {
        whereClause.formId = formId;
      }
      
      // Add search conditions based on search type
      if (isIdSearch) {
        whereClause.id = { contains: searchValue };
      } else {
        whereClause.OR = [
          { email: { contains: searchValue, mode: 'insensitive' } },
          { data: { path: ['$.email'], string_contains: searchValue, mode: 'insensitive' } }
        ];
      }

      // Build the search query with complete submission data
      const submissions = await db.submission.findMany({
        where: whereClause,
        orderBy: { createdAt: 'desc' },
        take: 50, // Increased from 10 to provide more results
        select: {
          id: true,
          createdAt: true,
          email: true,
          data: true, // Include the actual submission data
          formId: true,
          form: {
            select: {
              id: true,
              name: true,
              description: true,
              emailSettings: {
                select: {
                  enabled: true,
                  developerNotificationsEnabled: true
                }
              }
            }
          },
          notificationLogs: {
            select: {
              id: true,
              type: true,
              status: true,
              error: true,
              createdAt: true,
            },
            orderBy: { createdAt: 'desc' }
          }
        }
      });

      // Enhance submissions with analytics data and format notification logs
      const enhancedSubmissions = submissions.map(submission => {
        const data = submission.data as any;
        const meta = data?._meta || {};
        
        // Format notification logs to ensure consistent structure
        const formattedLogs = submission.notificationLogs.map(log => ({
          ...log,
          createdAt: log.createdAt.toISOString(),
          type: log.type,
          status: log.status,
          error: log.error || null
        }));

        // Add default logs if they don't exist
        const hasUserEmailLog = formattedLogs.some(log => log.type === 'SUBMISSION_CONFIRMATION');
        const hasDevEmailLog = formattedLogs.some(log => log.type === 'DEVELOPER_NOTIFICATION');

        if (!hasUserEmailLog && submission.email) {
          formattedLogs.push({
            id: `temp-${submission.id}-user-email`,
            type: 'SUBMISSION_CONFIRMATION',
            status: 'SKIPPED',
            error: 'Email not sent - plan or settings not configured',
            createdAt: submission.createdAt.toISOString()
          });
        }

        if (!hasDevEmailLog) {
          formattedLogs.push({
            id: `temp-${submission.id}-dev-email`,
            type: 'DEVELOPER_NOTIFICATION',
            status: submission.form.emailSettings?.developerNotificationsEnabled ? 'SKIPPED' : 'FAILED',
            error: submission.form.emailSettings?.developerNotificationsEnabled 
              ? 'Developer notification not sent' 
              : 'Developer notifications are disabled',
            createdAt: submission.createdAt.toISOString()
          });
        }

        return {
          id: submission.id,
          createdAt: submission.createdAt,
          email: submission.email,
          formId: submission.formId,
          formName: submission.form?.name || "Unknown Form",
          formDescription: submission.form?.description || "",
          data: submission.data,
          notificationLogs: formattedLogs,
          analytics: {
            browser: meta.browser || 'Unknown',
            location: meta.country || 'Unknown',
          }
        };
      });

      return c.superjson({
        submissions: enhancedSubmissions
      });
    }),

});
