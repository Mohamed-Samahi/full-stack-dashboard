import { describe, expect, it } from "vitest";

import {
    TicketStatus,
} from "../../../../src/generated/prisma/enums.js";

import type {
    TicketActor,
} from "../../../../src/features/tickets/ticket.types.js";

import {
    assertSupportedRole,
    getTicketVisibilityWhere,
    isRequester,
    isAssignedEmployee,
    hasAgentAccess,
    assertTicketNotClosed,
    assertTicketUpdateAllowed,
    getAssignmentPermission,
    assertTicketAssignmentAllowed,
    assertTicketTransitionAllowed,
} from "../../../../src/features/tickets/ticket.authorization.js";

type TicketResource = Parameters<
    typeof assertTicketTransitionAllowed
>[1];

const actor = (
    role: string,
    id = "actor-id"
): TicketActor => ({
    id,
    role,
    permissions: [],
});

const resource = (
    overrides: Partial<TicketResource> = {}
): TicketResource => ({
    requesterId: "requester-id",
    assigneeId: null,
    status: TicketStatus.OPEN,
    ...overrides,
});

function expectError(
    operation: () => unknown,
    statusCode: number
) {
    expect(operation).toThrow(
        expect.objectContaining({ statusCode })
    );
}

describe("Ticket Visibility Predicate", () => {
    it("should expose all tickets to ADMIN", () => {
        expect(getTicketVisibilityWhere(actor("ADMIN")))
            .toEqual({});
    });

    it("should scope EMPLOYEE visibility", () => {
        expect(getTicketVisibilityWhere(actor("EMPLOYEE")))
            .toEqual({
                OR: [
                    { assigneeId: null },
                    { assigneeId: "actor-id" },
                    { requesterId: "actor-id" },
                ],
            });
    });

    it("should restrict USER visibility to ownership", () => {
        expect(getTicketVisibilityWhere(actor("USER")))
            .toEqual({
                requesterId: "actor-id",
            });
    });

    it("should reject unsupported roles", () => {
        expectError(
            () => assertSupportedRole(actor("CUSTOM")),
            403
        );

        expectError(
            () => getTicketVisibilityWhere(actor("CUSTOM")),
            403
        );
    });
});

describe("Ticket Relationship Capabilities", () => {
    it("should recognize requester independently of role", () => {
        const ticket = resource({
            requesterId: "actor-id",
        });

        for (const role of ["ADMIN", "EMPLOYEE", "USER"]) {
            expect(isRequester(actor(role), ticket))
                .toBe(true);
        }
    });

    it("should require both employee role and assignment", () => {
        const ticket = resource({
            assigneeId: "actor-id",
        });

        expect(isAssignedEmployee(
            actor("EMPLOYEE"),
            ticket
        )).toBe(true);

        expect(isAssignedEmployee(
            actor("USER"),
            ticket
        )).toBe(false);

        expect(isAssignedEmployee(
            actor("EMPLOYEE", "another-id"),
            ticket
        )).toBe(false);
    });

    it("should combine requester and assignee capabilities", () => {
        const ticket = resource({
            requesterId: "actor-id",
            assigneeId: "actor-id",
        });

        const employee = actor("EMPLOYEE");

        expect(isRequester(employee, ticket)).toBe(true);
        expect(isAssignedEmployee(employee, ticket)).toBe(true);
        expect(hasAgentAccess(employee, ticket)).toBe(true);

        expect(() => assertTicketUpdateAllowed(
            employee,
            ticket,
            { priority: "HIGH" }
        )).not.toThrow();
    });
});

describe("Ticket Editing Policy", () => {
    it.each([
        TicketStatus.OPEN,
        TicketStatus.IN_PROGRESS,
    ])("should permit agent updates in %s", (status) => {
        const ticket = resource({
            assigneeId: "actor-id",
            status,
        });

        for (const role of ["ADMIN", "EMPLOYEE"]) {
            expect(() => assertTicketUpdateAllowed(
                actor(role),
                ticket,
                {
                    title: "Updated",
                    description: "Updated",
                    priority: "HIGH",
                }
            )).not.toThrow();
        }
    });

    it("should permit requester content updates only", () => {
        const ticket = resource({
            requesterId: "actor-id",
        });

        expect(() => assertTicketUpdateAllowed(
            actor("USER"),
            ticket,
            { title: "Updated" }
        )).not.toThrow();

        expectError(
            () => assertTicketUpdateAllowed(
                actor("USER"),
                ticket,
                { title: "Updated", priority: "HIGH" }
            ),
            403
        );
    });

    it("should prohibit requester edits after progress starts", () => {
        expectError(
            () => assertTicketUpdateAllowed(
                actor("USER"),
                resource({
                    requesterId: "actor-id",
                    status: TicketStatus.IN_PROGRESS,
                }),
                { title: "Updated" }
            ),
            409
        );
    });

    it("should prohibit unrelated employee updates", () => {
        expectError(
            () => assertTicketUpdateAllowed(
                actor("EMPLOYEE"),
                resource(),
                { title: "Updated" }
            ),
            403
        );
    });

    it.each([
        TicketStatus.RESOLVED,
        TicketStatus.CLOSED,
    ])("should reject administrative edits in %s", (status) => {
        expectError(
            () => assertTicketUpdateAllowed(
                actor("ADMIN"),
                resource({ status }),
                { title: "Updated" }
            ),
            409
        );
    });
});

describe("Ticket Assignment Policy", () => {
    it("should resolve role-specific assignment permissions", () => {
        expect(getAssignmentPermission(actor("ADMIN")))
            .toBe("ticket:assign");

        expect(getAssignmentPermission(actor("EMPLOYEE")))
            .toBe("ticket:self-assign");

        expectError(
            () => getAssignmentPermission(actor("USER")),
            403
        );
    });

    it("should permit employee self-assignment", () => {
        expect(() => assertTicketAssignmentAllowed(
            actor("EMPLOYEE"),
            resource(),
            "actor-id"
        )).not.toThrow();
    });

    it.each([null, "another-employee"])(
        "should prohibit employee assignment to %s",
        (assigneeId) => {
            expectError(
                () => assertTicketAssignmentAllowed(
                    actor("EMPLOYEE"),
                    resource(),
                    assigneeId
                ),
                403
            );
        }
    );

    it("should reject claiming an already assigned ticket", () => {
        expectError(
            () => assertTicketAssignmentAllowed(
                actor("EMPLOYEE"),
                resource({
                    assigneeId: "another-employee",
                }),
                "actor-id"
            ),
            409
        );
    });

    it("should prohibit assignment changes on closed tickets", () => {
        expectError(
            () => assertTicketAssignmentAllowed(
                actor("ADMIN"),
                resource({
                    status: TicketStatus.CLOSED,
                }),
                null
            ),
            409
        );
    });
});

describe("Ticket Lifecycle Policy", () => {
    const statuses = Object.values(TicketStatus);

    const transitions = [
        "OPEN:IN_PROGRESS",
        "IN_PROGRESS:RESOLVED",
        "RESOLVED:OPEN",
        "RESOLVED:CLOSED",
    ];

    const cases = statuses.flatMap((from) =>
        statuses.map((to) => ({
            from,
            to,
            allowed: transitions.includes(`${from}:${to}`),
        }))
    );

    it.each(cases)(
        "should enforce $from -> $to for ADMIN",
        ({ from, to, allowed }) => {
            const operation = () =>
                assertTicketTransitionAllowed(
                    actor("ADMIN"),
                    resource({
                        status: from,
                        assigneeId: "employee-id",
                    }),
                    to
                );

            if (allowed) {
                expect(operation).not.toThrow();
            } else {
                expectError(operation, 409);
            }
        }
    );

    it.each([
        TicketStatus.OPEN,
        TicketStatus.CLOSED,
    ])("should allow requester transition from RESOLVED to %s", (status) => {
        expect(() => assertTicketTransitionAllowed(
            actor("USER"),
            resource({
                requesterId: "actor-id",
                status: TicketStatus.RESOLVED,
            }),
            status
        )).not.toThrow();
    });

    it.each([
        {
            from: TicketStatus.OPEN,
            to: TicketStatus.IN_PROGRESS,
        },
        {
            from: TicketStatus.IN_PROGRESS,
            to: TicketStatus.RESOLVED,
        },
    ])("should prohibit requester-only agent transitions", ({ from, to }) => {
        expectError(
            () => assertTicketTransitionAllowed(
                actor("USER"),
                resource({
                    requesterId: "actor-id",
                    status: from,
                    assigneeId: "employee-id",
                }),
                to
            ),
            403
        );
    });

    it("should require assignment before entering progress", () => {
        expectError(
            () => assertTicketTransitionAllowed(
                actor("ADMIN"),
                resource(),
                TicketStatus.IN_PROGRESS
            ),
            409
        );
    });

    it("should reject closed-ticket mutations", () => {
        expectError(
            () => assertTicketNotClosed(
                resource({
                    status: TicketStatus.CLOSED,
                })
            ),
            409
        );
    });
});