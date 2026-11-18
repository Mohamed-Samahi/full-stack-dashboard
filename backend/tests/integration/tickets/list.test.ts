import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
    createTicketActor,
    createTestTicket,
} from "../../factories/ticket.factory.js";

import {
    withAuth,
} from "../../helpers/auth.helper.js";

import { api } from "../../helpers/api.helper.js";

import {
    setupIntegrationTests,
} from "../../setup/integration.js";

import * as ticketService from "../../../src/features/tickets/ticket.service.js";

import type {
    TicketListResponse,
} from "../../../src/features/tickets/ticket.types.js";

const endpoint = "/api/v1/tickets";

type Query = Record<string, string | number>;

async function listTickets(
    token: string,
    query: Query = {}
): Promise<TicketListResponse> {
    const response = await api
        .get(endpoint)
        .set(withAuth(token))
        .query(query)
        .expect(200);

    return response.body as TicketListResponse;
}

function getIds(response: TicketListResponse): string[] {
    return response.data.map(({ id }) => id);
}

function expectTicketIds(
    response: TicketListResponse,
    expectedIds: string[]
) {
    expect(getIds(response).sort())
        .toEqual([...expectedIds].sort());
}

function expectPagination(
    response: TicketListResponse,
    page: number,
    limit: number,
    total: number
) {
    expect(response.pagination).toEqual({
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
    });
}

async function createListingFixtures() {
    const admin = await createTicketActor("ADMIN");
    const employee = await createTicketActor("EMPLOYEE");
    const otherEmployee = await createTicketActor("EMPLOYEE");
    const user = await createTicketActor("USER");
    const otherUser = await createTicketActor("USER");

    const unassigned = await createTestTicket({
        requesterId: user.user.id,
        title: "Payment failure",
        description: "Unable to complete checkout",
        status: "OPEN",
        priority: "HIGH",
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-06"),
    });

    const assigned = await createTestTicket({
        requesterId: user.user.id,
        assigneeId: employee.user.id,
        title: "Checkout issue",
        description: "PAYMENT service unavailable",
        status: "IN_PROGRESS",
        priority: "HIGH",
        createdAt: new Date("2025-01-02"),
        updatedAt: new Date("2025-01-05"),
    });

    const shared = await createTestTicket({
        requesterId: employee.user.id,
        assigneeId: employee.user.id,
        title: "Payment configuration",
        description: "Configuration requires review",
        status: "OPEN",
        priority: "HIGH",
        createdAt: new Date("2025-01-03"),
        updatedAt: new Date("2025-01-04"),
    });

    const requested = await createTestTicket({
        requesterId: employee.user.id,
        assigneeId: otherEmployee.user.id,
        title: "Account access",
        description: "Unable to access account",
        status: "RESOLVED",
        priority: "MEDIUM",
        createdAt: new Date("2025-01-04"),
        updatedAt: new Date("2025-01-05"),
    });

    const inaccessible = await createTestTicket({
        requesterId: otherUser.user.id,
        assigneeId: otherEmployee.user.id,
        title: "Payment confidential",
        description: "Restricted payment issue",
        status: "OPEN",
        priority: "HIGH",
        createdAt: new Date("2025-01-05"),
        updatedAt: new Date("2025-01-07"),
    });

    const closed = await createTestTicket({
        requesterId: user.user.id,
        assigneeId: employee.user.id,
        title: "Payment completed",
        description: "Previously reported issue",
        status: "CLOSED",
        priority: "LOW",
        createdAt: new Date("2025-01-06"),
        updatedAt: new Date("2025-01-08"),
    });

    return {
        admin,
        employee,
        otherEmployee,
        user,
        otherUser,
        unassigned,
        assigned,
        shared,
        requested,
        inaccessible,
        closed,
    };
}

describe("Ticket Filtering, Search & Pagination", () => {
    setupIntegrationTests();

    describe("Query Validation", () => {
        it.each([
            "status=PENDING",
            "priority=URGENT",
            "assignment=all",
            "assigneeId=invalid-uuid",

            "page=0",
            "page=-1",
            "page=1.5",
            "page=1e2",
            "page=9007199254740992",

            "limit=0",
            "limit=101",
            "limit=1.5",

            "page=1002&limit=100",

            "sortBy=title",
            "sortOrder=invalid",

            "search=",
            "search=%20%20",
            "search=%00",

            "unexpected=value",
            "requesterId=invalid",

            "page=1&page=2",
            "limit=20&limit=20",
            "search=payment&search=account",
            "status=OPEN&status=CLOSED",

            "page%5Bgt%5D=1",
            "status%5B%5D=OPEN",

            `assignment=unassigned&assigneeId=${randomUUID()}`,
        ])("should return 400 for invalid query: %s", async (query) => {
            const actor = await createTicketActor("USER");

            const response = await api
                .get(`${endpoint}?${query}`)
                .set(withAuth(actor.accessToken))
                .expect(400);

            expect(response.body).toMatchObject({
                status: "error",
                message: "Validation failed",
            });

            expect(
                response.body.errors
            ).toEqual(expect.any(Array));

            expect(
                response.body.errors.length
            ).toBeGreaterThan(0);
        });

        it("should reject invalid input before executing the listing service", async () => {
            const actor = await createTicketActor("USER");

            const serviceSpy = vi.spyOn(
                ticketService,
                "getTickets"
            );

            try {
                await api
                    .get(`${endpoint}?page=1&page=2`)
                    .set(withAuth(actor.accessToken))
                    .expect(400);

                expect(serviceSpy)
                    .not.toHaveBeenCalled();
            } finally {
                serviceSpy.mockRestore();
            }
        });

        it("should pass validated and transformed query data to the service", async () => {
            const actor = await createTicketActor("USER");

            const serviceSpy = vi.spyOn(
                ticketService,
                "getTickets"
            );

            try {
                await listTickets(actor.accessToken, {
                    search: "  payment  ",
                    page: "2",
                    limit: "10",
                });

                expect(serviceSpy)
                    .toHaveBeenCalledOnce();

                expect(serviceSpy)
                    .toHaveBeenCalledWith(
                        expect.objectContaining({
                            id: actor.user.id,
                        }),
                        {
                            search: "payment",
                            page: 2,
                            limit: 10,
                            sortBy: "createdAt",
                            sortOrder: "desc",
                        }
                    );
            } finally {
                serviceSpy.mockRestore();
            }
        });
    });

    describe("Ticket Filtering", () => {
        it("should filter tickets by status", async () => {
            const f = await createListingFixtures();

            const result = await listTickets(
                f.admin.accessToken,
                { status: "OPEN" }
            );

            expectTicketIds(result, [
                f.unassigned.id,
                f.shared.id,
                f.inaccessible.id,
            ]);

            expectPagination(result, 1, 20, 3);
        });

        it("should filter tickets by priority", async () => {
            const f = await createListingFixtures();

            const result = await listTickets(
                f.admin.accessToken,
                { priority: "HIGH" }
            );

            expectTicketIds(result, [
                f.unassigned.id,
                f.assigned.id,
                f.shared.id,
                f.inaccessible.id,
            ]);

            expectPagination(result, 1, 20, 4);
        });

        it("should filter assigned and unassigned tickets", async () => {
            const f = await createListingFixtures();

            const assigned = await listTickets(
                f.admin.accessToken,
                { assignment: "assigned" }
            );

            expectTicketIds(assigned, [
                f.assigned.id,
                f.shared.id,
                f.requested.id,
                f.inaccessible.id,
                f.closed.id,
            ]);

            expectPagination(assigned, 1, 20, 5);

            const unassigned = await listTickets(
                f.admin.accessToken,
                { assignment: "unassigned" }
            );

            expectTicketIds(unassigned, [
                f.unassigned.id,
            ]);

            expectPagination(unassigned, 1, 20, 1);
        });

        it("should filter tickets by assignee ID", async () => {
            const f = await createListingFixtures();

            const result = await listTickets(
                f.admin.accessToken,
                {
                    assigneeId: f.employee.user.id,
                }
            );

            expectTicketIds(result, [
                f.assigned.id,
                f.shared.id,
                f.closed.id,
            ]);

            expectPagination(result, 1, 20, 3);
        });

        it("should combine all supported filters using AND", async () => {
            const f = await createListingFixtures();

            const result = await listTickets(
                f.admin.accessToken,
                {
                    search: "payment",
                    status: "OPEN",
                    priority: "HIGH",
                    assignment: "assigned",
                    assigneeId: f.employee.user.id,
                }
            );

            expectTicketIds(result, [
                f.shared.id,
            ]);

            expectPagination(result, 1, 20, 1);
        });

        it("should return an empty collection for unmatched filters", async () => {
            const f = await createListingFixtures();

            const result = await listTickets(
                f.admin.accessToken,
                {
                    status: "OPEN",
                    priority: "LOW",
                }
            );

            expect(result.data).toEqual([]);
            expectPagination(result, 1, 20, 0);
        });

        it("should return an empty collection for an unknown assignee", async () => {
            const f = await createListingFixtures();

            const result = await listTickets(
                f.admin.accessToken,
                {
                    assigneeId: randomUUID(),
                }
            );

            expect(result.data).toEqual([]);
            expectPagination(result, 1, 20, 0);
        });
    });

    describe("Ticket Search", () => {
        it("should search titles and descriptions using case-insensitive substring matching", async () => {
            const f = await createListingFixtures();

            const result = await listTickets(
                f.admin.accessToken,
                {
                    search: "  AyMeNt  ",
                }
            );

            expectTicketIds(result, [
                f.unassigned.id,
                f.assigned.id,
                f.shared.id,
                f.inaccessible.id,
                f.closed.id,
            ]);

            expectPagination(result, 1, 20, 5);
        });

        it("should combine search with status and priority filters", async () => {
            const f = await createListingFixtures();

            const result = await listTickets(
                f.admin.accessToken,
                {
                    search: "payment",
                    status: "IN_PROGRESS",
                    priority: "HIGH",
                }
            );

            expectTicketIds(result, [
                f.assigned.id,
            ]);

            expectPagination(result, 1, 20, 1);
        });

        it.each([
            ["50%", "50X"],
            ["file_name", "fileXname"],
            ["root\\path", "rootpath"],
            ["100%_done\\path", "100XXdonepath"],
        ])("should search literal pattern %s without interpreting wildcards", async (pattern, decoy) => {
            const actor = await createTicketActor("USER");

            const titleMatch = await createTestTicket({
                requesterId: actor.user.id,
                title: `Issue: ${pattern}`,
                description: "General issue",
            });

            const descriptionMatch = await createTestTicket({
                requesterId: actor.user.id,
                title: "Another issue",
                description: `Details: ${pattern}`,
            });

            await createTestTicket({
                requesterId: actor.user.id,
                title: `Issue: ${decoy}`,
                description: `Details: ${decoy}`,
            });

            const result = await listTickets(
                actor.accessToken,
                { search: pattern }
            );

            expectTicketIds(result, [
                titleMatch.id,
                descriptionMatch.id,
            ]);

            expectPagination(result, 1, 20, 2);
        });

        it("should treat SQL-like search input as literal text", async () => {
            const actor = await createTicketActor("USER");

            const pattern = "' OR 1=1 --";

            const matching = await createTestTicket({
                requesterId: actor.user.id,
                title: `Reported input: ${pattern}`,
            });

            await createTestTicket({
                requesterId: actor.user.id,
                title: "Unrelated issue",
            });

            const result = await listTickets(
                actor.accessToken,
                { search: pattern }
            );

            expectTicketIds(result, [
                matching.id,
            ]);

            expectPagination(result, 1, 20, 1);
        });

        it("should return accurate empty search results", async () => {
            const f = await createListingFixtures();

            const result = await listTickets(
                f.admin.accessToken,
                {
                    search: "nonexistent-search-value",
                }
            );

            expect(result.data).toEqual([]);
            expectPagination(result, 1, 20, 0);
        });
    });

    describe("Ticket Sorting", () => {
        it.each([
            "asc",
            "desc",
        ] as const)("should sort by creation date in %s order", async (sortOrder) => {
            const f = await createListingFixtures();

            const expected = [
                f.unassigned.id,
                f.assigned.id,
                f.shared.id,
                f.requested.id,
                f.inaccessible.id,
                f.closed.id,
            ];

            const result = await listTickets(
                f.admin.accessToken,
                {
                    sortBy: "createdAt",
                    sortOrder,
                }
            );

            expect(getIds(result)).toEqual(
                sortOrder === "asc"
                    ? expected
                    : [...expected].reverse()
            );
        });

        it.each([
            "asc",
            "desc",
        ] as const)("should sort by update date in %s order", async (sortOrder) => {
            const f = await createListingFixtures();

            const expected = [
                f.shared.id,

                ...[
                    f.assigned.id,
                    f.requested.id,
                ].sort(),

                f.unassigned.id,
                f.inaccessible.id,
                f.closed.id,
            ];

            const result = await listTickets(
                f.admin.accessToken,
                {
                    sortBy: "updatedAt",
                    sortOrder,
                }
            );

            expect(getIds(result)).toEqual(
                sortOrder === "asc"
                    ? expected
                    : [...expected].reverse()
            );
        });

        it.each([
            "asc",
            "desc",
        ] as const)("should sort priority in business-defined %s order", async (sortOrder) => {
            const f = await createListingFixtures();

            const expected = [
                f.closed.id,
                f.requested.id,

                ...[
                    f.unassigned.id,
                    f.assigned.id,
                    f.shared.id,
                    f.inaccessible.id,
                ].sort(),
            ];

            const result = await listTickets(
                f.admin.accessToken,
                {
                    sortBy: "priority",
                    sortOrder,
                }
            );

            expect(getIds(result)).toEqual(
                sortOrder === "asc"
                    ? expected
                    : [...expected].reverse()
            );
        });

        it.each([
            {
                sortBy: "createdAt",
                sortOrder: "asc",
            },
            {
                sortBy: "createdAt",
                sortOrder: "desc",
            },
            {
                sortBy: "updatedAt",
                sortOrder: "asc",
            },
            {
                sortBy: "updatedAt",
                sortOrder: "desc",
            },
            {
                sortBy: "priority",
                sortOrder: "asc",
            },
            {
                sortBy: "priority",
                sortOrder: "desc",
            },
        ] as const)("should apply deterministic secondary sorting", async ({
            sortBy,
            sortOrder,
        }) => {
            const actor = await createTicketActor("USER");

            const timestamp = new Date("2025-01-01");

            const tickets = await Promise.all(
                Array.from({ length: 4 }, () =>
                    createTestTicket({
                        requesterId: actor.user.id,
                        priority: "MEDIUM",
                        createdAt: timestamp,
                        updatedAt: timestamp,
                    })
                )
            );

            const expected = tickets
                .map(({ id }) => id)
                .sort();

            if (sortOrder === "desc") {
                expected.reverse();
            }

            const result = await listTickets(
                actor.accessToken,
                {
                    sortBy,
                    sortOrder,
                }
            );

            expect(getIds(result)).toEqual(expected);
        });
    });

    describe("Ticket Pagination", () => {
        it("should return consecutive non-overlapping pages with accurate metadata", async () => {
            const f = await createListingFixtures();

            const expected = [
                f.closed.id,
                f.inaccessible.id,
                f.requested.id,
                f.shared.id,
                f.assigned.id,
                f.unassigned.id,
            ];

            const allIds: string[] = [];

            for (let page = 1; page <= 3; page++) {
                const result = await listTickets(
                    f.admin.accessToken,
                    {
                        page,
                        limit: 2,
                    }
                );

                expect(result.data).toHaveLength(2);

                expectPagination(result, page, 2, 6);

                expect(getIds(result)).toEqual(
                    expected.slice(
                        (page - 1) * 2,
                        page * 2
                    )
                );

                allIds.push(...getIds(result));
            }

            expect(allIds).toEqual(expected);

            expect(new Set(allIds).size).toBe(6);
        });

        it("should return a partially filled final page", async () => {
            const f = await createListingFixtures();

            const result = await listTickets(
                f.employee.accessToken,
                {
                    page: 3,
                    limit: 2,
                }
            );

            expectTicketIds(result, [
                f.unassigned.id,
            ]);

            expectPagination(result, 3, 2, 5);
        });

        it("should preserve filtered totals across pages", async () => {
            const f = await createListingFixtures();

            const expected = [
                f.shared.id,
                f.assigned.id,
                f.unassigned.id,
            ];

            for (let page = 1; page <= 2; page++) {
                const result = await listTickets(
                    f.employee.accessToken,
                    {
                        search: "payment",
                        priority: "HIGH",
                        page,
                        limit: 2,
                    }
                );

                expect(getIds(result)).toEqual(
                    expected.slice(
                        (page - 1) * 2,
                        page * 2
                    )
                );

                expectPagination(result, page, 2, 3);
            }
        });

        it("should return empty data for out-of-range pages while preserving totals", async () => {
            const f = await createListingFixtures();

            const result = await listTickets(
                f.admin.accessToken,
                {
                    status: "OPEN",
                    page: 5,
                    limit: 2,
                }
            );

            expect(result.data).toEqual([]);
            expectPagination(result, 5, 2, 3);
        });

        it("should preserve zero totals when a filtered collection is empty", async () => {
            const f = await createListingFixtures();

            const result = await listTickets(
                f.user.accessToken,
                {
                    status: "RESOLVED",
                    page: 3,
                    limit: 10,
                }
            );

            expect(result.data).toEqual([]);
            expectPagination(result, 3, 10, 0);
        });

        it("should preserve deterministic ordering across pages with equal primary sort values", async () => {
            const actor = await createTicketActor("USER");

            const timestamp = new Date("2025-01-01");

            const tickets = await Promise.all(
                Array.from({ length: 5 }, () =>
                    createTestTicket({
                        requesterId: actor.user.id,
                        createdAt: timestamp,
                    })
                )
            );

            const expected = tickets
                .map(({ id }) => id)
                .sort();

            const collected: string[] = [];

            for (let page = 1; page <= 3; page++) {
                const result = await listTickets(
                    actor.accessToken,
                    {
                        page,
                        limit: 2,
                        sortBy: "createdAt",
                        sortOrder: "asc",
                    }
                );

                collected.push(...getIds(result));

                expectPagination(result, page, 2, 5);
            }

            expect(collected).toEqual(expected);
            expect(new Set(collected).size).toBe(5);
        });

        it("should enforce minimum and maximum page sizes", async () => {
            const f = await createListingFixtures();

            const minimum = await listTickets(
                f.admin.accessToken,
                { limit: 1 }
            );

            expect(minimum.data).toHaveLength(1);
            expectPagination(minimum, 1, 1, 6);

            const maximum = await listTickets(
                f.admin.accessToken,
                { limit: 100 }
            );

            expect(maximum.data).toHaveLength(6);
            expectPagination(maximum, 1, 100, 6);
        });

        it("should accept the maximum permitted offset", async () => {
            const f = await createListingFixtures();

            const result = await listTickets(
                f.admin.accessToken,
                {
                    page: 1001,
                    limit: 100,
                }
            );

            expect(result.data).toEqual([]);
            expectPagination(result, 1001, 100, 6);
        });
    });

    describe("Authorization Isolation", () => {
        it("should restrict identical search queries according to each role's visibility", async () => {
            const f = await createListingFixtures();

            const query = {
                search: "payment",
                status: "OPEN",
                priority: "HIGH",
            };

            const adminResult = await listTickets(
                f.admin.accessToken,
                query
            );

            expectTicketIds(adminResult, [
                f.unassigned.id,
                f.shared.id,
                f.inaccessible.id,
            ]);

            expectPagination(adminResult, 1, 20, 3);

            const employeeResult = await listTickets(
                f.employee.accessToken,
                query
            );

            expectTicketIds(employeeResult, [
                f.unassigned.id,
                f.shared.id,
            ]);

            expectPagination(employeeResult, 1, 20, 2);

            const userResult = await listTickets(
                f.user.accessToken,
                query
            );

            expectTicketIds(userResult, [
                f.unassigned.id,
            ]);

            expectPagination(userResult, 1, 20, 1);
        });

        it("should not reveal inaccessible tickets through search", async () => {
            const f = await createListingFixtures();

            for (const actor of [
                f.employee,
                f.user,
            ]) {
                const result = await listTickets(
                    actor.accessToken,
                    {
                        search: "confidential",
                    }
                );

                expect(result.data).toEqual([]);
                expectPagination(result, 1, 20, 0);
            }
        });

        it("should not expand visibility through assignee filters", async () => {
            const f = await createListingFixtures();

            const employeeResult = await listTickets(
                f.employee.accessToken,
                {
                    assignment: "assigned",
                    assigneeId: f.otherEmployee.user.id,
                }
            );

            expectTicketIds(employeeResult, [
                f.requested.id,
            ]);

            expectPagination(
                employeeResult,
                1,
                20,
                1
            );

            const userResult = await listTickets(
                f.user.accessToken,
                {
                    assignment: "assigned",
                    assigneeId: f.otherEmployee.user.id,
                }
            );

            expect(userResult.data).toEqual([]);
            expectPagination(userResult, 1, 20, 0);
        });

        it("should count tickets matching multiple employee visibility conditions only once", async () => {
            const f = await createListingFixtures();

            const result = await listTickets(
                f.employee.accessToken,
                {
                    search: "Payment configuration",
                    assigneeId: f.employee.user.id,
                    limit: 1,
                }
            );

            expectTicketIds(result, [
                f.shared.id,
            ]);

            expectPagination(result, 1, 1, 1);
        });

        it("should exclude inaccessible records from pagination totals", async () => {
            const f = await createListingFixtures();

            const result = await listTickets(
                f.user.accessToken,
                {
                    search: "payment",
                    limit: 1,
                    page: 2,
                }
            );

            expectTicketIds(result, [
                f.assigned.id,
            ]);

            expectPagination(result, 2, 1, 3);
        });

        it("should update filtered results and totals after reassignment", async () => {
            const f = await createListingFixtures();

            const query = {
                search: "payment",
                priority: "HIGH",
                assignment: "assigned",
                limit: 1,
            };

            const before = await listTickets(
                f.employee.accessToken,
                query
            );

            expectPagination(before, 1, 1, 2);

            for (const ticket of [
                f.assigned,
                f.shared,
            ]) {
                await api
                    .patch(
                        `${endpoint}/${ticket.id}/assignment`
                    )
                    .set(withAuth(f.admin.accessToken))
                    .send({
                        assigneeId: f.otherEmployee.user.id,
                    })
                    .expect(200);
            }

            const after = await listTickets(
                f.employee.accessToken,
                query
            );

            // Requester access survives reassignment.
            expectTicketIds(after, [
                f.shared.id,
            ]);

            expectPagination(after, 1, 1, 1);

            const newAssignee = await listTickets(
                f.otherEmployee.accessToken,
                {
                    ...query,
                    limit: 20,
                }
            );

            expectTicketIds(newAssignee, [
                f.assigned.id,
                f.shared.id,
                f.inaccessible.id,
            ]);

            expectPagination(
                newAssignee,
                1,
                20,
                3
            );

            const requester = await listTickets(
                f.user.accessToken,
                query
            );

            expectTicketIds(requester, [
                f.assigned.id,
            ]);

            expectPagination(requester, 1, 1, 1);
        });

        it("should preserve authorized search access to CLOSED tickets", async () => {
            const f = await createListingFixtures();

            const query = {
                search: "payment",
                status: "CLOSED",
                priority: "LOW",
            };

            for (const actor of [
                f.admin,
                f.employee,
                f.user,
            ]) {
                const result = await listTickets(
                    actor.accessToken,
                    query
                );

                expectTicketIds(result, [
                    f.closed.id,
                ]);

                expectPagination(result, 1, 20, 1);
            }

            for (const actor of [
                f.otherEmployee,
                f.otherUser,
            ]) {
                const result = await listTickets(
                    actor.accessToken,
                    query
                );

                expect(result.data).toEqual([]);

                expectPagination(
                    result,
                    1,
                    20,
                    0
                );
            }
        });
    });
});