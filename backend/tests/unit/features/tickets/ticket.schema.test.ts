import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
    ticketParamsSchema,
    createTicketSchema,
    updateTicketSchema,
    assignTicketSchema,
    updateTicketStatusSchema,
} from "../../../../src/features/tickets/ticket.schema.js";

const validTicket = {
    title: "Application issue",
    description: "Unable to access the application",
};

describe("Ticket Creation Schema", () => {
    it("should accept and trim valid ticket fields", () => {
        expect(createTicketSchema.parse({
            title: "  Application issue  ",
            description: "  Unable to access the application  ",
        })).toEqual(validTicket);
    });

    it.each([
        "",
        "   ",
        "\n\t",
        "a".repeat(201),
        null,
        123,
        undefined,
    ])("should reject invalid title: %s", (title) => {
        expect(createTicketSchema.safeParse({
            ...validTicket,
            title,
        }).success).toBe(false);
    });

    it.each([
        "",
        "   ",
        "\n\t",
        "a".repeat(10001),
        null,
        123,
        undefined,
    ])("should reject invalid description", (description) => {
        expect(createTicketSchema.safeParse({
            ...validTicket,
            description,
        }).success).toBe(false);
    });

    it("should accept maximum field lengths", () => {
        expect(createTicketSchema.safeParse({
            title: "a".repeat(200),
            description: "a".repeat(10000),
        }).success).toBe(true);
    });

    it.each([
        "id",
        "requesterId",
        "assigneeId",
        "updatedById",
        "priority",
        "status",
        "createdAt",
        "updatedAt",
        "unexpected",
    ])("should reject client-supplied %s", (field) => {
        expect(createTicketSchema.safeParse({
            ...validTicket,
            [field]: randomUUID(),
        }).success).toBe(false);
    });
});

describe("Ticket Update Schema", () => {
    it.each([
        { title: "Updated title" },
        { description: "Updated description" },
        { priority: "LOW" },
        { priority: "MEDIUM" },
        { priority: "HIGH" },
        {
            title: "Updated title",
            description: "Updated description",
            priority: "HIGH",
        },
    ])("should accept supported fields", (payload) => {
        expect(updateTicketSchema.safeParse(payload).success)
            .toBe(true);
    });

    it.each([
        {},
        { title: "" },
        { title: "   " },
        { title: "a".repeat(201) },
        { description: "" },
        { description: "a".repeat(10001) },
        { priority: "URGENT" },
        { priority: null },
        { status: "CLOSED" },
        { assigneeId: null },
        { requesterId: randomUUID() },
        { updatedById: randomUUID() },
        { createdAt: new Date().toISOString() },
        { updatedAt: new Date().toISOString() },
    ])("should reject invalid update payloads", (payload) => {
        expect(updateTicketSchema.safeParse(payload).success)
            .toBe(false);
    });
});

describe("Ticket Parameters Schema", () => {
    it("should accept a valid ticket UUID", () => {
        expect(ticketParamsSchema.safeParse({
            ticketId: randomUUID(),
        }).success).toBe(true);
    });

    it.each([
        {},
        { ticketId: "invalid-id" },
        { ticketId: "" },
        { ticketId: null },
        { ticketId: 123 },
    ])("should reject malformed identifiers", (payload) => {
        expect(ticketParamsSchema.safeParse(payload).success)
            .toBe(false);
    });
});

describe("Ticket Assignment Schema", () => {
    it.each([randomUUID(), null])(
        "should accept valid assignment: %s",
        (assigneeId) => {
            expect(assignTicketSchema.safeParse({
                assigneeId,
            }).success).toBe(true);
        }
    );

    it.each([
        {},
        { assigneeId: "" },
        { assigneeId: "invalid-id" },
        { assigneeId: 123 },
        { assigneeId: null, status: "OPEN" },
        { assigneeId: null, requesterId: randomUUID() },
    ])("should reject invalid assignment payloads", (payload) => {
        expect(assignTicketSchema.safeParse(payload).success)
            .toBe(false);
    });
});

describe("Ticket Status Schema", () => {
    it.each([
        "OPEN",
        "IN_PROGRESS",
        "RESOLVED",
        "CLOSED",
    ])("should accept status %s", (status) => {
        expect(updateTicketStatusSchema.safeParse({
            status,
        }).success).toBe(true);
    });

    it.each([
        {},
        { status: "PENDING" },
        { status: "open" },
        { status: null },
        { status: 123 },
        { status: "OPEN", assigneeId: null },
    ])("should reject invalid status payloads", (payload) => {
        expect(
            updateTicketStatusSchema.safeParse(payload).success
        ).toBe(false);
    });
});