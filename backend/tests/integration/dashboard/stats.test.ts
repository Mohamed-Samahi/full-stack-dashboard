import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";

import {
    PERMISSIONS,
} from "../../../src/features/rbac/rbac.constants.js";

import type {
    DashboardStats,
} from "../../../src/features/dashboard/dashboard.service.js";

import type {
    TicketStatus,
} from "../../../src/generated/prisma/client.js";

import type {
    TicketListResponse,
} from "../../../src/features/tickets/ticket.types.js";

import {
    createTicketActor,
    createTestTicket,
} from "../../factories/ticket.factory.js";

import {
    createTestUser,
} from "../../factories/user.factory.js";

import {
    createTestAccessToken,
    withAuth,
} from "../../helpers/auth.helper.js";

import { api } from "../../helpers/api.helper.js";

import {
    setupIntegrationTests,
} from "../../setup/integration.js";

import {
    PNG,
} from "../../fixtures/files/attachment.fixtures.js";

// --------------------------------------------
// External storage mock
// --------------------------------------------

const storage = vi.hoisted(() => ({
    upload: vi.fn(),
    remove: vi.fn(),
    createSignedUrl: vi.fn(),
    list: vi.fn(),
}));

vi.mock(
    "../../../src/config/storage.js",
    async (importOriginal) => ({
        ...await importOriginal<object>(),
        getStorageBucket: () => storage,
    })
);

// --------------------------------------------
// Helpers
// --------------------------------------------

const endpoint = "/api/v1/dashboard/stats";
const ticketEndpoint = "/api/v1/tickets";
const rbacEndpoint = "/api/v1/rbac/users";

const zeroStats: DashboardStats = {
    total: 0,
    open: 0,
    inProgress: 0,
    resolved: 0,
    closed: 0,
};

type StatusCounts = Omit<DashboardStats, "total">;

const stats = (
    counts: Partial<StatusCounts> = {}
): DashboardStats => {
    const result = {
        ...zeroStats,
        ...counts,
    };

    return {
        ...result,
        total:
            result.open +
            result.inProgress +
            result.resolved +
            result.closed,
    };
};

async function getStats(
    token: string
): Promise<DashboardStats> {
    const response = await api
        .get(endpoint)
        .set(withAuth(token))
        .expect(200);

    return response.body.data;
}

async function expectStats(
    token: string,
    expected: DashboardStats
): Promise<DashboardStats> {
    const response = await api
        .get(endpoint)
        .set(withAuth(token))
        .expect(200);

    expect(response.body).toEqual({
        data: expected,
    });

    const data: DashboardStats = response.body.data;

    expect(data.total).toBe(
        data.open +
        data.inProgress +
        data.resolved +
        data.closed
    );

    for (const count of Object.values(data)) {
        expect(Number.isInteger(count)).toBe(true);
        expect(count).toBeGreaterThanOrEqual(0);
    }

    return data;
}

async function listTickets(
    token: string,
    query: {
        page?: number;
        limit?: number;
        status?: TicketStatus;
    } = {}
): Promise<TicketListResponse> {
    const response = await api
        .get(ticketEndpoint)
        .set(withAuth(token))
        .query(query)
        .expect(200);

    return response.body as TicketListResponse;
}

const assign = (
    ticketId: string,
    assigneeId: string | null,
    token: string
) =>
    api
        .patch(`${ticketEndpoint}/${ticketId}/assignment`)
        .set(withAuth(token))
        .send({ assigneeId });

const transition = (
    ticketId: string,
    status: TicketStatus,
    token: string
) =>
    api
        .patch(`${ticketEndpoint}/${ticketId}/status`)
        .set(withAuth(token))
        .send({ status });

const changeRole = (
    userId: string,
    roleId: string,
    token: string
) =>
    api
        .patch(`${rbacEndpoint}/${userId}/role`)
        .set(withAuth(token))
        .send({ roleId });

// --------------------------------------------
// Fixtures
// --------------------------------------------

async function createStatisticsFixtures() {
    const admin = await createTicketActor("ADMIN");
    const employee = await createTicketActor("EMPLOYEE");
    const otherEmployee = await createTicketActor("EMPLOYEE");
    const user = await createTicketActor("USER");
    const otherUser = await createTicketActor("USER");

    const unassigned = await createTestTicket({
        requesterId: user.user.id,
        status: "OPEN",
    });

    const assigned = await createTestTicket({
        requesterId: user.user.id,
        assigneeId: employee.user.id,
        status: "IN_PROGRESS",
    });

    // Matches requester and assignee visibility.
    const shared = await createTestTicket({
        requesterId: employee.user.id,
        assigneeId: employee.user.id,
        status: "OPEN",
    });

    // Visible to employee through requester ownership.
    const requested = await createTestTicket({
        requesterId: employee.user.id,
        assigneeId: otherEmployee.user.id,
        status: "RESOLVED",
    });

    // Inaccessible to employee and user.
    const inaccessible = await createTestTicket({
        requesterId: otherUser.user.id,
        assigneeId: otherEmployee.user.id,
        status: "OPEN",
    });

    const closed = await createTestTicket({
        requesterId: user.user.id,
        assigneeId: employee.user.id,
        status: "CLOSED",
    });

    // Matches requester and unassigned visibility.
    const ownUnassigned = await createTestTicket({
        requesterId: employee.user.id,
        status: "OPEN",
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
        ownUnassigned,
    };
}

// --------------------------------------------
// Tests
// --------------------------------------------

describe("Dashboard & Ticket Statistics", () => {
    setupIntegrationTests();

    beforeEach(() => {
        storage.upload.mockReset();
        storage.remove.mockReset();
        storage.createSignedUrl.mockReset();
        storage.list.mockReset();

        storage.upload.mockResolvedValue({
            data: {},
            error: null,
        });

        storage.remove.mockResolvedValue({
            data: [],
            error: null,
        });

        storage.list.mockResolvedValue({
            data: [],
            error: null,
        });
    });

    // ----------------------------------------
    // Authentication & permission enforcement
    // ----------------------------------------

    describe("Authentication & Authorization", () => {
        it("should reject unauthenticated requests", async () => {
            await api
                .get(endpoint)
                .expect(401);
        });

        it("should reject invalid access tokens", async () => {
            await api
                .get(endpoint)
                .set(withAuth("invalid-token"))
                .expect(401);
        });

        it.each([
            "ADMIN",
            "EMPLOYEE",
            "USER",
        ] as const)(
            "should reject %s without ticket:read permission",
            async (role) => {
                const { user } = await createTestUser({
                    role,
                    permissions: [
                        PERMISSIONS.TICKET_CREATE,
                    ],
                    hashPassword: false,
                });

                const token = await createTestAccessToken(
                    user.id
                );

                await api
                    .get(endpoint)
                    .set(withAuth(token))
                    .expect(403);
            }
        );

        it("should reject unsupported roles even with ticket:read permission", async () => {
            const { user } = await createTestUser({
                role: "CUSTOM_ROLE",
                permissions: [
                    PERMISSIONS.TICKET_READ,
                ],
                hashPassword: false,
            });

            const token = await createTestAccessToken(
                user.id
            );

            await api
                .get(endpoint)
                .set(withAuth(token))
                .expect(403);
        });
    });

    // ----------------------------------------
    // Aggregation accuracy
    // ----------------------------------------

    describe("Aggregation Accuracy", () => {
        it.each([
            "ADMIN",
            "EMPLOYEE",
            "USER",
        ] as const)(
            "should return zero counts for %s when no tickets exist",
            async (role) => {
                const actor = await createTicketActor(role);

                await expectStats(
                    actor.accessToken,
                    zeroStats
                );
            }
        );

        it("should return zero counts when all persisted tickets are inaccessible", async () => {
            const user = await createTicketActor("USER");
            const owner = await createTicketActor("USER");
            const employee = await createTicketActor("EMPLOYEE");
            const otherEmployee = await createTicketActor("EMPLOYEE");

            await createTestTicket({
                requesterId: owner.user.id,
                assigneeId: otherEmployee.user.id,
                status: "OPEN",
            });

            await createTestTicket({
                requesterId: owner.user.id,
                assigneeId: otherEmployee.user.id,
                status: "CLOSED",
            });

            await expectStats(
                user.accessToken,
                zeroStats
            );

            await expectStats(
                employee.accessToken,
                zeroStats
            );
        });

        it.each([
            ["OPEN", "open"],
            ["IN_PROGRESS", "inProgress"],
            ["RESOLVED", "resolved"],
            ["CLOSED", "closed"],
        ] as const)(
            "should populate %s count and default missing statuses to zero",
            async (status, field) => {
                const user = await createTicketActor("USER");
                const employee = await createTicketActor("EMPLOYEE");

                for (let index = 0; index < 3; index++) {
                    await createTestTicket({
                        requesterId: user.user.id,
                        assigneeId: employee.user.id,
                        status,
                    });
                }

                await expectStats(
                    user.accessToken,
                    stats({
                        [field]: 3,
                    })
                );
            }
        );
    });

    // ----------------------------------------
    // Role-based visibility
    // ----------------------------------------

    describe("Role-Based Statistics", () => {
        const visibilityCases = [
            {
                actor: "admin",
                expected: stats({
                    open: 4,
                    inProgress: 1,
                    resolved: 1,
                    closed: 1,
                }),
            },
            {
                actor: "employee",
                expected: stats({
                    open: 3,
                    inProgress: 1,
                    resolved: 1,
                    closed: 1,
                }),
            },
            {
                actor: "otherEmployee",
                expected: stats({
                    open: 3,
                    resolved: 1,
                }),
            },
            {
                actor: "user",
                expected: stats({
                    open: 1,
                    inProgress: 1,
                    closed: 1,
                }),
            },
            {
                actor: "otherUser",
                expected: stats({
                    open: 1,
                }),
            },
        ] as const;

        it.each(visibilityCases)(
            "should return only authorized statistics for $actor",
            async ({ actor, expected }) => {
                const fixtures =
                    await createStatisticsFixtures();

                await expectStats(
                    fixtures[actor].accessToken,
                    expected
                );
            }
        );

        it("should count overlapping employee visibility conditions only once", async () => {
            const employee = await createTicketActor("EMPLOYEE");

            // Requester + assignee.
            await createTestTicket({
                requesterId: employee.user.id,
                assigneeId: employee.user.id,
                status: "IN_PROGRESS",
            });

            // Requester + unassigned.
            await createTestTicket({
                requesterId: employee.user.id,
                assigneeId: null,
                status: "OPEN",
            });

            await expectStats(
                employee.accessToken,
                stats({
                    open: 1,
                    inProgress: 1,
                })
            );
        });
    });

    // ----------------------------------------
    // Ticket-list consistency
    // ----------------------------------------

    describe("Ticket Listing Consistency", () => {
        it.each([
            "admin",
            "employee",
            "otherEmployee",
            "user",
            "otherUser",
        ] as const)(
            "should match authorized pagination.total for $actor regardless of pagination",
            async (actor) => {
                const fixtures =
                    await createStatisticsFixtures();

                const token = fixtures[actor].accessToken;

                const dashboard = await getStats(token);

                const queries = [
                    { page: 1, limit: 1 },
                    { page: 2, limit: 1 },
                    { page: 1, limit: 2 },
                    { page: 1, limit: 100 },
                    { page: 100, limit: 1 },
                ];

                for (const query of queries) {
                    const listing = await listTickets(
                        token,
                        query
                    );

                    expect(
                        listing.pagination.total
                    ).toBe(dashboard.total);

                    expect(
                        listing.pagination.totalPages
                    ).toBe(
                        Math.ceil(
                            dashboard.total / query.limit
                        )
                    );

                    expect(
                        listing.data.length
                    ).toBeLessThanOrEqual(query.limit);

                    await expectStats(
                        token,
                        dashboard
                    );
                }

                const emptyPage = await listTickets(
                    token,
                    {
                        page: 100,
                        limit: 1,
                    }
                );

                expect(emptyPage.data).toEqual([]);

                expect(
                    emptyPage.pagination.total
                ).toBe(dashboard.total);
            }
        );

        it.each([
            "admin",
            "employee",
            "user",
        ] as const)(
            "should match authorized per-status listing totals for $actor",
            async (actor) => {
                const fixtures =
                    await createStatisticsFixtures();

                const token = fixtures[actor].accessToken;

                const dashboard = await getStats(token);

                const statuses = [
                    ["OPEN", "open"],
                    ["IN_PROGRESS", "inProgress"],
                    ["RESOLVED", "resolved"],
                    ["CLOSED", "closed"],
                ] as const;

                for (const [status, field] of statuses) {
                    const listing = await listTickets(
                        token,
                        {
                            status,
                            limit: 1,
                        }
                    );

                    expect(
                        listing.pagination.total
                    ).toBe(dashboard[field]);
                }

                // Filtered listing requests must not alter
                // the unfiltered dashboard statistics.
                await expectStats(
                    token,
                    dashboard
                );
            }
        );
    });

    // ----------------------------------------
    // Ticket creation
    // ----------------------------------------

    describe("Ticket Creation Consistency", () => {
        it("should increment total and OPEN counts only for authorized actors", async () => {
            const admin = await createTicketActor("ADMIN");
            const employee = await createTicketActor("EMPLOYEE");
            const user = await createTicketActor("USER");
            const otherUser = await createTicketActor("USER");

            const visibleActors = [
                admin,
                employee,
                user,
            ];

            for (const actor of visibleActors) {
                await expectStats(
                    actor.accessToken,
                    zeroStats
                );
            }

            await api
                .post(ticketEndpoint)
                .set(withAuth(user.accessToken))
                .send({
                    title: "Dashboard statistics ticket",
                    description: "Verify statistics after creation",
                })
                .expect(201);

            for (const actor of visibleActors) {
                await expectStats(
                    actor.accessToken,
                    stats({ open: 1 })
                );
            }

            await expectStats(
                otherUser.accessToken,
                zeroStats
            );
        });
    });

    // ----------------------------------------
    // Assignment & reassignment
    // ----------------------------------------

    describe("Assignment Consistency", () => {
        it("should update employee visibility after assignment, reassignment and unassignment", async () => {
            const admin = await createTicketActor("ADMIN");
            const employee = await createTicketActor("EMPLOYEE");
            const replacement = await createTicketActor("EMPLOYEE");
            const user = await createTicketActor("USER");

            const ticket = await createTestTicket({
                requesterId: user.user.id,
                status: "OPEN",
            });

            const expected = stats({
                open: 1,
            });

            await expectStats(
                employee.accessToken,
                expected
            );

            await expectStats(
                replacement.accessToken,
                expected
            );

            // Assign to first employee.
            await assign(
                ticket.id,
                employee.user.id,
                admin.accessToken
            ).expect(200);

            await expectStats(
                employee.accessToken,
                expected
            );

            await expectStats(
                replacement.accessToken,
                zeroStats
            );

            // Reassign to another employee.
            await assign(
                ticket.id,
                replacement.user.id,
                admin.accessToken
            ).expect(200);

            await expectStats(
                employee.accessToken,
                zeroStats
            );

            await expectStats(
                replacement.accessToken,
                expected
            );

            // Unassign: both employees regain visibility.
            await assign(
                ticket.id,
                null,
                admin.accessToken
            ).expect(200);

            await expectStats(
                employee.accessToken,
                expected
            );

            await expectStats(
                replacement.accessToken,
                expected
            );

            await expectStats(
                admin.accessToken,
                expected
            );

            await expectStats(
                user.accessToken,
                expected
            );
        });

        it("should preserve employee requester statistics after reassignment", async () => {
            const admin = await createTicketActor("ADMIN");
            const employee = await createTicketActor("EMPLOYEE");
            const replacement = await createTicketActor("EMPLOYEE");

            const ticket = await createTestTicket({
                requesterId: employee.user.id,
                assigneeId: employee.user.id,
                status: "IN_PROGRESS",
            });

            const expected = stats({
                inProgress: 1,
            });

            await expectStats(
                employee.accessToken,
                expected
            );

            await expectStats(
                replacement.accessToken,
                zeroStats
            );

            await assign(
                ticket.id,
                replacement.user.id,
                admin.accessToken
            ).expect(200);

            await expectStats(
                employee.accessToken,
                expected
            );

            await expectStats(
                replacement.accessToken,
                expected
            );

            await expectStats(
                admin.accessToken,
                expected
            );
        });
    });

    // ----------------------------------------
    // Lifecycle transitions
    // ----------------------------------------

    describe("Lifecycle Consistency", () => {
        it("should update status counts without changing the total throughout the ticket lifecycle", async () => {
            const admin = await createTicketActor("ADMIN");
            const employee = await createTicketActor("EMPLOYEE");
            const requester = await createTicketActor("USER");

            const ticket = await createTestTicket({
                requesterId: requester.user.id,
                assigneeId: employee.user.id,
                status: "OPEN",
            });

            const actors = [
                admin,
                employee,
                requester,
            ];

            const assertAll = async (
                expected: DashboardStats
            ) => {
                for (const actor of actors) {
                    await expectStats(
                        actor.accessToken,
                        expected
                    );
                }
            };

            await assertAll(
                stats({ open: 1 })
            );

            // OPEN -> IN_PROGRESS
            await transition(
                ticket.id,
                "IN_PROGRESS",
                employee.accessToken
            ).expect(200);

            await assertAll(
                stats({ inProgress: 1 })
            );

            // IN_PROGRESS -> RESOLVED
            await transition(
                ticket.id,
                "RESOLVED",
                employee.accessToken
            ).expect(200);

            await assertAll(
                stats({ resolved: 1 })
            );

            // RESOLVED -> OPEN
            await transition(
                ticket.id,
                "OPEN",
                requester.accessToken
            ).expect(200);

            await assertAll(
                stats({ open: 1 })
            );

            // OPEN -> IN_PROGRESS
            await transition(
                ticket.id,
                "IN_PROGRESS",
                employee.accessToken
            ).expect(200);

            await assertAll(
                stats({ inProgress: 1 })
            );

            // IN_PROGRESS -> RESOLVED
            await transition(
                ticket.id,
                "RESOLVED",
                employee.accessToken
            ).expect(200);

            await assertAll(
                stats({ resolved: 1 })
            );

            // RESOLVED -> CLOSED
            await transition(
                ticket.id,
                "CLOSED",
                requester.accessToken
            ).expect(200);

            await assertAll(
                stats({ closed: 1 })
            );
        });

        it("should preserve statistics after rejected status transitions", async () => {
            const admin = await createTicketActor("ADMIN");
            const requester = await createTicketActor("USER");

            const ticket = await createTestTicket({
                requesterId: requester.user.id,
                status: "OPEN",
            });

            const before = await getStats(
                requester.accessToken
            );

            await transition(
                ticket.id,
                "CLOSED",
                admin.accessToken
            ).expect(409);

            await expectStats(
                requester.accessToken,
                before
            );

            await expectStats(
                admin.accessToken,
                before
            );
        });
    });

    // ----------------------------------------
    // Role changes
    // ----------------------------------------

    describe("Role Change Consistency", () => {
        it("should apply the new visibility scope after employee demotion", async () => {
            const admin = await createTicketActor("ADMIN");
            const employee = await createTicketActor("EMPLOYEE");
            const user = await createTicketActor("USER");

            // Preserved requester ownership.
            await createTestTicket({
                requesterId: employee.user.id,
                status: "OPEN",
            });

            // Unassigned ticket belonging to another user.
            await createTestTicket({
                requesterId: user.user.id,
                status: "OPEN",
            });

            // Historical assignment permits demotion.
            await createTestTicket({
                requesterId: user.user.id,
                assigneeId: employee.user.id,
                status: "CLOSED",
            });

            const before = stats({
                open: 2,
                closed: 1,
            });

            await expectStats(
                employee.accessToken,
                before
            );

            await changeRole(
                employee.user.id,
                user.user.roleId,
                admin.accessToken
            ).expect(200);

            // Previously issued token must be invalidated.
            await api
                .get(endpoint)
                .set(withAuth(employee.accessToken))
                .expect(401);

            const newToken = await createTestAccessToken(
                employee.user.id
            );

            await expectStats(
                newToken,
                stats({ open: 1 })
            );

            const listing = await listTickets(
                newToken,
                { limit: 1 }
            );

            expect(
                listing.pagination.total
            ).toBe(1);

            // Global statistics remain unchanged.
            await expectStats(
                admin.accessToken,
                before
            );
        });

        it("should expand visibility after USER promotion to EMPLOYEE", async () => {
            const admin = await createTicketActor("ADMIN");
            const employee = await createTicketActor("EMPLOYEE");
            const user = await createTicketActor("USER");
            const otherUser = await createTicketActor("USER");

            await createTestTicket({
                requesterId: user.user.id,
                status: "OPEN",
            });

            await createTestTicket({
                requesterId: otherUser.user.id,
                status: "OPEN",
            });

            await createTestTicket({
                requesterId: otherUser.user.id,
                assigneeId: employee.user.id,
                status: "IN_PROGRESS",
            });

            await expectStats(
                user.accessToken,
                stats({ open: 1 })
            );

            await changeRole(
                user.user.id,
                employee.user.roleId,
                admin.accessToken
            ).expect(200);

            await api
                .get(endpoint)
                .set(withAuth(user.accessToken))
                .expect(401);

            const newToken = await createTestAccessToken(
                user.user.id
            );

            await expectStats(
                newToken,
                stats({ open: 2 })
            );

            const listing = await listTickets(
                newToken,
                { limit: 1 }
            );

            expect(
                listing.pagination.total
            ).toBe(2);
        });
    });

    // ----------------------------------------
    // Comments & attachments
    // ----------------------------------------

    describe("Child Resource Consistency", () => {
        it("should preserve dashboard statistics after comment and attachment creation", async () => {
            const admin = await createTicketActor("ADMIN");
            const employee = await createTicketActor("EMPLOYEE");
            const user = await createTicketActor("USER");

            const ticket = await createTestTicket({
                requesterId: user.user.id,
                assigneeId: employee.user.id,
                status: "IN_PROGRESS",
            });

            const actors = [
                admin,
                employee,
                user,
            ];

            const expected = stats({
                inProgress: 1,
            });

            for (const actor of actors) {
                await expectStats(
                    actor.accessToken,
                    expected
                );
            }

            await api
                .post(`${ticketEndpoint}/${ticket.id}/comments`)
                .set(withAuth(user.accessToken))
                .send({
                    content: "Additional ticket information",
                })
                .expect(201);

            for (const actor of actors) {
                await expectStats(
                    actor.accessToken,
                    expected
                );
            }

            await api
                .post(`${ticketEndpoint}/${ticket.id}/attachments`)
                .set(withAuth(user.accessToken))
                .attach("file", PNG, {
                    filename: "image.png",
                    contentType: "image/png",
                })
                .expect(201);

            expect(storage.upload)
                .toHaveBeenCalledTimes(1);

            for (const actor of actors) {
                await expectStats(
                    actor.accessToken,
                    expected
                );
            }
        });
    });
});