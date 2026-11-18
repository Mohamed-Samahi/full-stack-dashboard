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
};

export type {
    CreateTicketData,
    UpdateTicketData,
    AssignTicketData,
    UpdateTicketStatusData,
};