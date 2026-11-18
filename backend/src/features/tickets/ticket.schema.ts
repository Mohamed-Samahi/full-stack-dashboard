import { z } from "zod";

import {
    TicketStatus,
    TicketPriority,
} from "../../generated/prisma/enums.js";

const ticketTitleSchema = z
    .string()
    .trim()
    .min(1)
    .max(200);

const ticketDescriptionSchema = z
    .string()
    .trim()
    .min(1)
    .max(10000);

const ticketParamsSchema = z.strictObject({
    ticketId: z.uuid(),
});

const createTicketSchema = z.strictObject({
    title: ticketTitleSchema,
    description: ticketDescriptionSchema,
});

const updateTicketSchema = z
    .strictObject({
        title: ticketTitleSchema.optional(),
        description: ticketDescriptionSchema.optional(),
        priority: z.enum(TicketPriority).optional(),
    })
    .refine(
        (data) =>
            data.title !== undefined ||
            data.description !== undefined ||
            data.priority !== undefined,
        {
            message: "At least one supported field is required",
        }
    );

const assignTicketSchema = z.strictObject({
    assigneeId: z.uuid().nullable(),
});

const updateTicketStatusSchema = z.strictObject({
    status: z.enum(TicketStatus),
});

const MAX_OFFSET = 100_000;

const paginationIntegerSchema = z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform(Number)
    .pipe(
        z.number()
            .int()
            .positive()
    );

const listTicketsQuerySchema = z
    .strictObject({
        search: z.string()
            .trim()
            .min(1)
            .max(200)
            .refine(
                (value) => !value.includes("\0"),
                {
                    message: "Invalid search characters",
                }
            )
            .optional(),

        status: z.enum(TicketStatus).optional(),

        priority: z.enum(TicketPriority).optional(),

        assigneeId: z.uuid().optional(),

        assignment: z.enum([
            "assigned",
            "unassigned",
        ]).optional(),

        page: paginationIntegerSchema
            .default(1),

        limit: paginationIntegerSchema
            .pipe(z.number().max(100))
            .default(20),

        sortBy: z.enum([
            "createdAt",
            "updatedAt",
            "priority",
        ]).default("createdAt"),

        sortOrder: z.enum([
            "asc",
            "desc",
        ]).default("desc"),
    })
    .superRefine((data, context) => {
        if (
            data.assignment === "unassigned" &&
            data.assigneeId !== undefined
        ) {
            context.addIssue({
                code: "custom",
                path: ["assigneeId"],
                message:
                    "Assignee ID cannot be combined with unassigned tickets",
            });
        }

        if (
            (data.page - 1) * data.limit > MAX_OFFSET
        ) {
            context.addIssue({
                code: "custom",
                path: ["page"],
                message: "Pagination offset exceeds the allowed limit",
            });
        }
    });

type ListTicketsQuery = z.infer<
    typeof listTicketsQuerySchema
>;

type CreateTicketData = z.infer<
    typeof createTicketSchema
>;

type UpdateTicketData = z.infer<
    typeof updateTicketSchema
>;

type AssignTicketData = z.infer<
    typeof assignTicketSchema
>;

type UpdateTicketStatusData = z.infer<
    typeof updateTicketStatusSchema
>;

export {
    ticketParamsSchema,
    createTicketSchema,
    updateTicketSchema,
    assignTicketSchema,
    updateTicketStatusSchema,
    listTicketsQuerySchema,
};

export type {
    CreateTicketData,
    UpdateTicketData,
    AssignTicketData,
    UpdateTicketStatusData,
    ListTicketsQuery,
};