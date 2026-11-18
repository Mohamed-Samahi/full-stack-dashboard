import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
    ticketParamsSchema,
    createTicketSchema,
    updateTicketSchema,
    assignTicketSchema,
    updateTicketStatusSchema,
    listTicketsQuerySchema,
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

describe("Ticket Listing Query Schema", () => {
    it("should apply default query values", () => {
        expect(
            listTicketsQuerySchema.parse({})
        ).toEqual({
            page: 1,
            limit: 20,
            sortBy: "createdAt",
            sortOrder: "desc",
        });
    });

    it("should accept combined filters and transform query values", () => {
        const assigneeId = randomUUID();

        expect(
            listTicketsQuerySchema.parse({
                search: "  application issue  ",
                status: "OPEN",
                priority: "HIGH",
                assignment: "assigned",
                assigneeId,
                page: "2",
                limit: "50",
                sortBy: "priority",
                sortOrder: "asc",
            })
        ).toEqual({
            search: "application issue",
            status: "OPEN",
            priority: "HIGH",
            assignment: "assigned",
            assigneeId,
            page: 2,
            limit: 50,
            sortBy: "priority",
            sortOrder: "asc",
        });
    });

    it.each([
        "OPEN",
        "IN_PROGRESS",
        "RESOLVED",
        "CLOSED",
    ])("should accept status %s", (status) => {
        expect(
            listTicketsQuerySchema.safeParse({
                status,
            }).success
        ).toBe(true);
    });

    it.each([
        "LOW",
        "MEDIUM",
        "HIGH",
    ])("should accept priority %s", (priority) => {
        expect(
            listTicketsQuerySchema.safeParse({
                priority,
            }).success
        ).toBe(true);
    });

    it.each([
        "assigned",
        "unassigned",
    ])("should accept assignment state %s", (assignment) => {
        expect(
            listTicketsQuerySchema.safeParse({
                assignment,
            }).success
        ).toBe(true);
    });

    it.each([
        "createdAt",
        "updatedAt",
        "priority",
    ])("should accept sorting field %s", (sortBy) => {
        expect(
            listTicketsQuerySchema.safeParse({
                sortBy,
            }).success
        ).toBe(true);
    });

    it.each(["asc", "desc"])(
        "should accept sorting direction %s",
        (sortOrder) => {
            expect(
                listTicketsQuerySchema.safeParse({
                    sortOrder,
                }).success
            ).toBe(true);
        }
    );

    it.each([
        "a",
        "a".repeat(200),
        "%",
        "_",
        "\\",
        "100%_complete\\path",
    ])("should accept valid literal search input", (search) => {
        expect(
            listTicketsQuerySchema.parse({
                search,
            }).search
        ).toBe(search);
    });

    it.each([
        "",
        "   ",
        "a".repeat(201),
        "invalid\0search",
        null,
        123,
        ["first", "second"],
    ])("should reject invalid search input", (search) => {
        expect(
            listTicketsQuerySchema.safeParse({
                search,
            }).success
        ).toBe(false);
    });

    it.each([
        { status: "PENDING" },
        { status: "open" },
        { priority: "URGENT" },
        { priority: "high" },
        { assignment: "all" },
        { assigneeId: "invalid-uuid" },
        { assigneeId: "" },
        { assigneeId: null },
        { sortBy: "title" },
        { sortBy: "status" },
        { sortOrder: "ASC" },
        { sortOrder: "random" },
        { unknown: "value" },
        { requesterId: randomUUID() },
        { "page[gte]": "1" },
        { "status[]": "OPEN" },
    ])("should reject unsupported query parameters or values", (query) => {
        expect(
            listTicketsQuerySchema.safeParse(query).success
        ).toBe(false);
    });

    it.each([
        "0",
        "-1",
        "1.5",
        "1e2",
        "0x10",
        "+1",
        " 1 ",
        "",
        "NaN",
        "Infinity",
        "9007199254740992",
        "9".repeat(400),
        null,
        true,
        1,
        ["1", "2"],
        { value: "1" },
    ])("should reject malformed pagination values", (value) => {
        for (const field of ["page", "limit"]) {
            expect(
                listTicketsQuerySchema.safeParse({
                    [field]: value,
                }).success
            ).toBe(false);
        }
    });

    it.each([
        "search",
        "status",
        "priority",
        "assigneeId",
        "assignment",
        "page",
        "limit",
        "sortBy",
        "sortOrder",
    ])("should reject repeated %s parameters", (field) => {
        const values: Record<string, string> = {
            search: "application",
            status: "OPEN",
            priority: "HIGH",
            assigneeId: randomUUID(),
            assignment: "assigned",
            page: "1",
            limit: "20",
            sortBy: "createdAt",
            sortOrder: "desc",
        };

        expect(
            listTicketsQuerySchema.safeParse({
                [field]: [
                    values[field],
                    values[field],
                ],
            }).success
        ).toBe(false);
    });

    it("should accept minimum and maximum page sizes", () => {
        for (const limit of ["1", "100"]) {
            expect(
                listTicketsQuerySchema.parse({
                    limit,
                }).limit
            ).toBe(Number(limit));
        }
    });

    it("should reject a page size exceeding 100", () => {
        expect(
            listTicketsQuerySchema.safeParse({
                limit: "101",
            }).success
        ).toBe(false);
    });

    it("should accept the maximum permitted offset", () => {
        expect(
            listTicketsQuerySchema.safeParse({
                page: "1001",
                limit: "100",
            }).success
        ).toBe(true);
    });

    it("should reject offsets exceeding 100000", () => {
        expect(
            listTicketsQuerySchema.safeParse({
                page: "1002",
                limit: "100",
            }).success
        ).toBe(false);
    });

    it("should reject conflicting assignment filters", () => {
        expect(
            listTicketsQuerySchema.safeParse({
                assignment: "unassigned",
                assigneeId: randomUUID(),
            }).success
        ).toBe(false);
    });

    it("should accept an assignee ID without assignment state", () => {
        expect(
            listTicketsQuerySchema.safeParse({
                assigneeId: randomUUID(),
            }).success
        ).toBe(true);
    });
});