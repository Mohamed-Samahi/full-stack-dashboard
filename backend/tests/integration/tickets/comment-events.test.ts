import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import jwt from "jsonwebtoken";

import {
    describe,
    expect,
    it,
    vi,
} from "vitest";

import { prisma } from "../../../src/config/db.js";

import {
    verifyAccessToken,
} from "../../../src/utils/jwt.js";

import {
    createTicketActor,
    createTestTicket,
    getTestTicket,
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
    setupSSETests,
} from "../../helpers/sse.helper.js";

import * as commentEvents from "../../../src/features/tickets/comments/comment.events.js";

import * as commentService from "../../../src/features/tickets/comments/comment.service.js";

import * as ticketService from "../../../src/features/tickets/ticket.service.js";

import type {
    TicketComment,
} from "../../../src/features/tickets/ticket.types.js";

const endpoint = "/api/v1/tickets";

const commentsEndpoint = (ticketId: string) =>
    `${endpoint}/${ticketId}/comments`;

const eventsEndpoint = (ticketId: string) =>
    `${commentsEndpoint(ticketId)}/events`;

const createComment = (
    ticketId: string,
    token: string,
    content = "Real-time comment"
) =>
    api
        .post(commentsEndpoint(ticketId))
        .set(withAuth(token))
        .send({ content });

const createShortLivedToken = (
    token: string,
    expiresIn: number
): string => {
    const payload = verifyAccessToken(token);

    return jwt.sign(
        {
            userId: payload.userId,
            roleId: payload.roleId,
            role: payload.role,
            permissions: payload.permissions,
            roleVersion: payload.roleVersion,
            userVersion: payload.userVersion,
        },
        process.env.JWT_ACCESS_SECRET!,
        { expiresIn }
    );
};

describe("Real-Time Ticket Conversations", () => {
    setupIntegrationTests();

    const { subscribe } = setupSSETests();

    it("should reject unauthenticated and invalid SSE connections", async () => {
        const owner = await createTicketActor("USER");

        const ticket = await createTestTicket({
            requesterId: owner.user.id,
        });

        await api
            .get(eventsEndpoint(ticket.id))
            .expect(401);

        await api
            .get(eventsEndpoint(ticket.id))
            .set(withAuth("invalid-token"))
            .expect(401);

        const expiredToken = createShortLivedToken(
            owner.accessToken,
            -1
        );

        await api
            .get(eventsEndpoint(ticket.id))
            .set(withAuth(expiredToken))
            .expect(401);
    });

    it("should reject malformed and nonexistent subscription identifiers", async () => {
        const owner = await createTicketActor("USER");

        await api
            .get(eventsEndpoint("invalid-id"))
            .set(withAuth(owner.accessToken))
            .expect(400);

        await api
            .get(eventsEndpoint(randomUUID()))
            .set(withAuth(owner.accessToken))
            .expect(404);
    });

    it("should enforce ticket:read permission on subscriptions", async () => {
        const { user } = await createTestUser({
            role: "USER",
            permissions: ["ticket:comment"],
        });

        const token = await createTestAccessToken(user.id);

        const ticket = await createTestTicket({
            requesterId: user.id,
        });

        await api
            .get(eventsEndpoint(ticket.id))
            .set(withAuth(token))
            .expect(403);
    });

    it("should reject subscriptions to inaccessible tickets", async () => {
        const owner = await createTicketActor("USER");
        const otherUser = await createTicketActor("USER");
        const employee = await createTicketActor("EMPLOYEE");
        const assignee = await createTicketActor("EMPLOYEE");

        const ticket = await createTestTicket({
            requesterId: owner.user.id,
            assigneeId: assignee.user.id,
        });

        for (const actor of [otherUser, employee]) {
            const response = await api
                .get(eventsEndpoint(ticket.id))
                .set(withAuth(actor.accessToken))
                .expect(404);

            expect(response.headers["content-type"])
                .not.toContain("text/event-stream");
        }
    });

    it("should deliver an initial empty conversation snapshot", async () => {
        const owner = await createTicketActor("USER");

        const ticket = await createTestTicket({
            requesterId: owner.user.id,
        });

        const connection = await subscribe(
            ticket.id,
            owner.accessToken
        );

        const snapshot = await connection.nextEvent(
            "comments.snapshot"
        );

        expect(snapshot.data).toEqual({
            data: [],
        });

        expect(connection.closed).toBe(false);

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it("should deliver the same persisted event to all authorized subscribers", async () => {
        const owner = await createTicketActor("USER");
        const admin = await createTicketActor("ADMIN");
        const employee = await createTicketActor("EMPLOYEE");

        const ticket = await createTestTicket({
            requesterId: owner.user.id,
            assigneeId: employee.user.id,
            updatedById: admin.user.id,
            updatedAt: new Date("2025-01-01"),
        });

        const subscribers = await Promise.all([
            subscribe(ticket.id, owner.accessToken),
            subscribe(ticket.id, admin.accessToken),
            subscribe(ticket.id, employee.accessToken),
        ]);

        await Promise.all(
            subscribers.map((connection) =>
                connection.nextEvent("comments.snapshot")
            )
        );

        const response = await createComment(
            ticket.id,
            owner.accessToken,
            "New conversation message"
        ).expect(201);

        const events = await Promise.all(
            subscribers.map((connection) =>
                connection.nextEvent("comment.created")
            )
        );

        for (const event of events) {
            expect(event.data).toEqual({
                data: response.body.data,
            });
        }

        expect(
            await prisma.ticketComment.findUnique({
                where: {
                    id: response.body.data.id,
                },
            })
        ).not.toBeNull();

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it("should isolate events between different ticket subscriptions", async () => {
        const owner = await createTicketActor("USER");

        const first = await createTestTicket({
            requesterId: owner.user.id,
        });

        const second = await createTestTicket({
            requesterId: owner.user.id,
        });

        const firstConnection = await subscribe(
            first.id,
            owner.accessToken
        );

        const secondConnection = await subscribe(
            second.id,
            owner.accessToken
        );

        await firstConnection.nextEvent("comments.snapshot");
        await secondConnection.nextEvent("comments.snapshot");

        const publication = vi.spyOn(
            commentEvents,
            "publishComment"
        );

        const firstResponse = await createComment(
            first.id,
            owner.accessToken,
            "First ticket message"
        ).expect(201);

        await firstConnection.nextEvent("comment.created");

        await publication.mock.results[0]?.value;

        const secondResponse = await createComment(
            second.id,
            owner.accessToken,
            "Second ticket message"
        ).expect(201);

        const secondEvent = await secondConnection.nextEvent(
            "comment.created"
        );

        expect(secondEvent.data.data.id)
            .toBe(secondResponse.body.data.id);

        await publication.mock.results[1]?.value;

        expect(secondConnection.events).not.toContainEqual(
            expect.objectContaining({
                event: "comment.created",
                data: {
                    data: firstResponse.body.data,
                },
            })
        );

        expect(firstConnection.events).toHaveLength(0);
    });

    it("should recover missed comments through a reconnection snapshot", async () => {
        const owner = await createTicketActor("USER");

        const ticket = await createTestTicket({
            requesterId: owner.user.id,
        });

        const first = await subscribe(
            ticket.id,
            owner.accessToken
        );

        await first.nextEvent("comments.snapshot");

        const original = await createComment(
            ticket.id,
            owner.accessToken,
            "Before disconnect"
        ).expect(201);

        await first.nextEvent("comment.created");

        first.close();

        const missed = await createComment(
            ticket.id,
            owner.accessToken,
            "During disconnect"
        ).expect(201);

        const reconnected = await subscribe(
            ticket.id,
            owner.accessToken
        );

        const snapshot = await reconnected.nextEvent(
            "comments.snapshot"
        );

        const comments: TicketComment[] = [
            original.body.data,
            missed.body.data,
        ];

        comments.sort((a, b) =>
            a.createdAt.localeCompare(b.createdAt) ||
            a.id.localeCompare(b.id)
        );

        expect(snapshot.data.data).toEqual(comments);

        const next = await createComment(
            ticket.id,
            owner.accessToken,
            "After reconnect"
        ).expect(201);

        expect(
            (
                await reconnected.nextEvent(
                    "comment.created"
                )
            ).data.data
        ).toEqual(next.body.data);
    });

    it("should reject revoked access tokens during connection initialization", async () => {
        const owner = await createTicketActor("USER");

        const ticket = await createTestTicket({
            requesterId: owner.user.id,
        });

        await prisma.user.update({
            where: { id: owner.user.id },
            data: {
                authVersion: {
                    increment: 1,
                },
            },
        });

        await api
            .get(eventsEndpoint(ticket.id))
            .set(withAuth(owner.accessToken))
            .expect(401);
    });

    it("should disconnect an expired subscriber before delivering new comments", async () => {
        const owner = await createTicketActor("USER");
        const admin = await createTicketActor("ADMIN");

        const ticket = await createTestTicket({
            requesterId: owner.user.id,
        });

        const shortToken = createShortLivedToken(
            owner.accessToken,
            4
        );

        const connection = await subscribe(
            ticket.id,
            shortToken
        );

        await connection.nextEvent("comments.snapshot");

        const decoded = jwt.decode(shortToken) as jwt.JwtPayload;

        const expiresAt = decoded.exp! * 1000;

        await delay(
            Math.max(0, expiresAt - Date.now()) + 100
        );

        await createComment(
            ticket.id,
            admin.accessToken,
            "Created after token expiration"
        ).expect(201);

        const error = await connection.nextEvent(
            "stream.error"
        );

        expect(error.data.status).toBe(401);

        await connection.waitUntilClosed();

        expect(connection.events).not.toContainEqual(
            expect.objectContaining({
                event: "comment.created",
            })
        );

        const newToken = await createTestAccessToken(
            owner.user.id
        );

        const reconnected = await subscribe(
            ticket.id,
            newToken
        );

        const snapshot = await reconnected.nextEvent(
            "comments.snapshot"
        );

        expect(snapshot.data.data).toHaveLength(1);
    });

    it.each(["user", "role"] as const)(
        "should prevent delivery after %s authentication-version revocation",
        async (target) => {
            const owner = await createTicketActor("USER");
            const admin = await createTicketActor("ADMIN");

            const ticket = await createTestTicket({
                requesterId: owner.user.id,
            });

            const connection = await subscribe(
                ticket.id,
                owner.accessToken
            );

            await connection.nextEvent("comments.snapshot");

            if (target === "user") {
                await prisma.user.update({
                    where: {
                        id: owner.user.id,
                    },
                    data: {
                        authVersion: {
                            increment: 1,
                        },
                    },
                });
            } else {
                await prisma.role.update({
                    where: {
                        id: owner.user.roleId,
                    },
                    data: {
                        authVersion: {
                            increment: 1,
                        },
                    },
                });
            }

            await createComment(
                ticket.id,
                admin.accessToken
            ).expect(201);

            const error = await connection.nextEvent(
                "stream.error"
            );

            expect(error.data.status).toBe(401);

            await connection.waitUntilClosed();

            expect(connection.events).not.toContainEqual(
                expect.objectContaining({
                    event: "comment.created",
                })
            );

            await api
                .get(eventsEndpoint(ticket.id))
                .set(withAuth(owner.accessToken))
                .expect(401);
        }
    );

    it("should revoke an active stream when its read permission is removed", async () => {
        const owner = await createTicketActor("USER");
        const admin = await createTicketActor("ADMIN");

        const ticket = await createTestTicket({
            requesterId: owner.user.id,
        });

        const connection = await subscribe(
            ticket.id,
            owner.accessToken
        );

        await connection.nextEvent("comments.snapshot");

        const permission = await prisma.permission.findUniqueOrThrow({
            where: {
                key: "ticket:read",
            },
        });

        // Deliberately leave the role version unchanged to
        // verify database permission revalidation independently.
        await prisma.rolePermission.delete({
            where: {
                roleId_permissionId: {
                    roleId: owner.user.roleId,
                    permissionId: permission.id,
                },
            },
        });

        await createComment(
            ticket.id,
            admin.accessToken
        ).expect(201);

        const error = await connection.nextEvent(
            "stream.error"
        );

        expect(error.data.status).toBe(403);

        await connection.waitUntilClosed();

        expect(connection.events).not.toContainEqual(
            expect.objectContaining({
                event: "comment.created",
            })
        );
    });

    it("should revoke existing subscriptions after an actual role change", async () => {
        const admin = await createTicketActor("ADMIN");
        const employee = await createTicketActor("EMPLOYEE");
        const owner = await createTicketActor("USER");

        const ticket = await createTestTicket({
            requesterId: owner.user.id,
        });

        const connection = await subscribe(
            ticket.id,
            employee.accessToken
        );

        await connection.nextEvent("comments.snapshot");

        await api
            .patch(`/api/v1/rbac/users/${employee.user.id}/role`)
            .set(withAuth(admin.accessToken))
            .send({
                roleId: owner.user.roleId,
            })
            .expect(200);

        await createComment(
            ticket.id,
            owner.accessToken
        ).expect(201);

        const error = await connection.nextEvent(
            "stream.error"
        );

        expect(error.data.status).toBe(401);

        await connection.waitUntilClosed();

        const newToken = await createTestAccessToken(
            employee.user.id
        );

        await api
            .get(eventsEndpoint(ticket.id))
            .set(withAuth(newToken))
            .expect(404);
    });

    it("should stop delivering events after reassignment removes visibility", async () => {
        const admin = await createTicketActor("ADMIN");
        const owner = await createTicketActor("USER");
        const first = await createTicketActor("EMPLOYEE");
        const second = await createTicketActor("EMPLOYEE");

        const ticket = await createTestTicket({
            requesterId: owner.user.id,
            assigneeId: first.user.id,
        });

        const formerAssignee = await subscribe(
            ticket.id,
            first.accessToken
        );

        const requester = await subscribe(
            ticket.id,
            owner.accessToken
        );

        await formerAssignee.nextEvent("comments.snapshot");
        await requester.nextEvent("comments.snapshot");

        await api
            .patch(`${endpoint}/${ticket.id}/assignment`)
            .set(withAuth(admin.accessToken))
            .send({
                assigneeId: second.user.id,
            })
            .expect(200);

        const currentAssignee = await subscribe(
            ticket.id,
            second.accessToken
        );

        await currentAssignee.nextEvent("comments.snapshot");

        const response = await createComment(
            ticket.id,
            second.accessToken
        ).expect(201);

        const denied = await formerAssignee.nextEvent(
            "stream.error"
        );

        expect(denied.data.status).toBe(404);

        await formerAssignee.waitUntilClosed();

        expect(formerAssignee.events).not.toContainEqual(
            expect.objectContaining({
                event: "comment.created",
            })
        );

        for (const connection of [
            requester,
            currentAssignee,
        ]) {
            const event = await connection.nextEvent(
                "comment.created"
            );

            expect(event.data.data)
                .toEqual(response.body.data);
        }

        await api
            .get(eventsEndpoint(ticket.id))
            .set(withAuth(first.accessToken))
            .expect(404);
    });

    it("should retain employee requester subscriptions after reassignment", async () => {
        const admin = await createTicketActor("ADMIN");
        const owner = await createTicketActor("EMPLOYEE");
        const other = await createTicketActor("EMPLOYEE");

        const ticket = await createTestTicket({
            requesterId: owner.user.id,
            assigneeId: owner.user.id,
        });

        const connection = await subscribe(
            ticket.id,
            owner.accessToken
        );

        await connection.nextEvent("comments.snapshot");

        await api
            .patch(`${endpoint}/${ticket.id}/assignment`)
            .set(withAuth(admin.accessToken))
            .send({
                assigneeId: other.user.id,
            })
            .expect(200);

        const response = await createComment(
            ticket.id,
            other.accessToken
        ).expect(201);

        const event = await connection.nextEvent(
            "comment.created"
        );

        expect(event.data.data).toEqual(response.body.data);
        expect(connection.closed).toBe(false);
    });

    it("should keep CLOSED conversations readable without publishing rejected comments", async () => {
        const admin = await createTicketActor("ADMIN");

        const ticket = await createTestTicket({
            requesterId: admin.user.id,
            status: "RESOLVED",
        });

        const existing = await createComment(
            ticket.id,
            admin.accessToken,
            "Historical message"
        ).expect(201);

        await api
            .patch(`${endpoint}/${ticket.id}/status`)
            .set(withAuth(admin.accessToken))
            .send({
                status: "CLOSED",
            })
            .expect(200);

        const closedTicket = await getTestTicket(ticket.id);

        const connection = await subscribe(
            ticket.id,
            admin.accessToken
        );

        const snapshot = await connection.nextEvent(
            "comments.snapshot"
        );

        expect(snapshot.data.data).toEqual([
            existing.body.data,
        ]);

        const publication = vi.spyOn(
            commentEvents,
            "publishComment"
        );

        await createComment(
            ticket.id,
            admin.accessToken,
            "Rejected comment"
        ).expect(409);

        expect(publication).not.toHaveBeenCalled();

        expect(connection.events).toHaveLength(0);
        expect(connection.closed).toBe(false);

        expect(await getTestTicket(ticket.id))
            .toEqual(closedTicket);

        expect(await prisma.ticketComment.count({
            where: {
                ticketId: ticket.id,
            },
        })).toBe(1);
    });

    it("should not lose comments during concurrent subscription initialization", async () => {
        const owner = await createTicketActor("USER");

        const ticket = await createTestTicket({
            requesterId: owner.user.id,
        });

        let releaseSnapshot!: () => void;
        let notifySnapshotStarted!: () => void;

        const snapshotStarted = new Promise<void>(
            (resolve) => {
                notifySnapshotStarted = resolve;
            }
        );

        const snapshotGate = new Promise<void>(
            (resolve) => {
                releaseSnapshot = resolve;
            }
        );

        const originalList = commentService.listTicketComments;

        vi.spyOn(
            commentService,
            "listTicketComments"
        ).mockImplementationOnce(
            async (tx, ticketId) => {
                const snapshot = await originalList(
                    tx,
                    ticketId
                );

                notifySnapshotStarted();

                // Keep the real ticket transaction open
                // after the snapshot query.
                await snapshotGate;

                return snapshot;
            }
        );

        const transactionSpy = vi.spyOn(
            ticketService,
            "withTicketTransaction"
        );

        const subscriptionPromise = subscribe(
            ticket.id,
            owner.accessToken
        );

        // Attach a rejection handler while the test
        // controls transaction execution.
        void subscriptionPromise.catch(() => { });

        let commentPromise:
            | ReturnType<typeof createComment>
            | undefined;

        let pendingPost:
            | Promise<Awaited<ReturnType<typeof createComment>>>
            | undefined;

        try {
            await snapshotStarted;

            commentPromise = createComment(
                ticket.id,
                owner.accessToken,
                "Created during subscription initialization"
            );

            pendingPost = commentPromise.then(
                (response) => response
            );

            void pendingPost.catch(() => { });

            // Confirm both operations entered the real
            // transaction mechanism before releasing it.
            await vi.waitFor(() => {
                expect(transactionSpy)
                    .toHaveBeenCalledTimes(2);
            }, {
                timeout: 3000,
            });
        } finally {
            releaseSnapshot();
        }

        if (!pendingPost) {
            throw new Error(
                "Comment request was not initialized"
            );
        }

        const [connection, response] = await Promise.all([
            subscriptionPromise,
            pendingPost,
        ]);

        expect(response.status).toBe(201);

        const snapshot = await connection.nextEvent(
            "comments.snapshot"
        );

        expect(snapshot.data.data).toEqual([]);

        const event = await connection.nextEvent(
            "comment.created"
        );

        expect(event.data.data).toEqual(response.body.data);

        expect(await prisma.ticketComment.count({
            where: {
                ticketId: ticket.id,
            },
        })).toBe(1);
    });

    it("should converge to persisted state when subscription and creation race", async () => {
        const owner = await createTicketActor("USER");

        const ticket = await createTestTicket({
            requesterId: owner.user.id,
        });

        const [connection, response] = await Promise.all([
            subscribe(
                ticket.id,
                owner.accessToken
            ),

            createComment(
                ticket.id,
                owner.accessToken,
                "Concurrent message"
            ).expect(201),
        ]);

        const snapshot = await connection.nextEvent(
            "comments.snapshot"
        );

        const knownComments = new Map(
            snapshot.data.data.map((comment) => [
                comment.id,
                comment,
            ])
        );

        const created = response.body.data as TicketComment;

        if (!knownComments.has(created.id)) {
            const event = await connection.nextEvent(
                "comment.created"
            );

            knownComments.set(
                event.data.data.id,
                event.data.data
            );
        }

        expect([...knownComments.values()])
            .toEqual([created]);
    });

    it("should publish comments only after database commit", async () => {
        const owner = await createTicketActor("USER");

        const ticket = await createTestTicket({
            requesterId: owner.user.id,
        });

        const connection = await subscribe(
            ticket.id,
            owner.accessToken
        );

        await connection.nextEvent("comments.snapshot");

        const originalPublish = commentEvents.publishComment;

        let persistedBeforePublication = false;

        const publication = vi.spyOn(
            commentEvents,
            "publishComment"
        ).mockImplementation(
            async (comment) => {
                // Independent database query outside
                // the insertion transaction.
                const saved = await prisma.ticketComment.findUnique({
                    where: {
                        id: comment.id,
                    },
                });

                persistedBeforePublication =
                    saved?.content === comment.content;

                await originalPublish(comment);
            }
        );

        const response = await createComment(
            ticket.id,
            owner.accessToken
        ).expect(201);

        const event = await connection.nextEvent(
            "comment.created"
        );

        expect(publication).toHaveBeenCalledTimes(1);

        expect(persistedBeforePublication).toBe(true);

        expect(event.data.data)
            .toEqual(response.body.data);

        await publication.mock.results[0]?.value;

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it("should not publish an event when an inserted comment is rolled back", async () => {
        const owner = await createTicketActor("USER");

        const ticket = await createTestTicket({
            requesterId: owner.user.id,
        });

        const connection = await subscribe(
            ticket.id,
            owner.accessToken
        );

        await connection.nextEvent("comments.snapshot");

        const publication = vi.spyOn(
            commentEvents,
            "publishComment"
        );

        const originalTransaction =
            ticketService.withTicketTransaction;

        let insertionReached = false;

        vi.spyOn(
            ticketService,
            "withTicketTransaction"
        ).mockImplementationOnce(
            async (operation) => {
                return originalTransaction(async (tx) => {
                    await operation(tx);

                    insertionReached =
                        await tx.ticketComment.count({
                            where: {
                                ticketId: ticket.id,
                            },
                        }) === 1;

                    throw new Error(
                        "Forced transaction rollback"
                    );
                });
            }
        );

        await createComment(
            ticket.id,
            owner.accessToken
        ).expect(500);

        expect(insertionReached).toBe(true);

        expect(publication).not.toHaveBeenCalled();

        expect(await prisma.ticketComment.count({
            where: {
                ticketId: ticket.id,
            },
        })).toBe(0);

        expect(connection.events).toHaveLength(0);

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);

        // Verify that a later successful transaction
        // still delivers events to the active subscriber.
        const successful = await createComment(
            ticket.id,
            owner.accessToken
        ).expect(201);

        const event = await connection.nextEvent(
            "comment.created"
        );

        expect(event.data.data)
            .toEqual(successful.body.data);
    });

    it("should preserve successful persistence if real-time publication fails", async () => {
        const owner = await createTicketActor("USER");

        const ticket = await createTestTicket({
            requesterId: owner.user.id,
        });

        vi.spyOn(
            commentEvents,
            "publishComment"
        ).mockRejectedValueOnce(
            new Error("Forced publication failure")
        );

        const response = await createComment(
            ticket.id,
            owner.accessToken
        ).expect(201);

        expect(await prisma.ticketComment.findUnique({
            where: {
                id: response.body.data.id,
            },
        })).not.toBeNull();

        const connection = await subscribe(
            ticket.id,
            owner.accessToken
        );

        const snapshot = await connection.nextEvent(
            "comments.snapshot"
        );

        expect(snapshot.data.data).toEqual([
            response.body.data,
        ]);

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it("should clean up heartbeat timers when a client disconnects", async () => {
        const owner = await createTicketActor("USER");

        const ticket = await createTestTicket({
            requesterId: owner.user.id,
        });

        const intervals = vi.spyOn(
            globalThis,
            "setInterval"
        );

        const clearedIntervals = vi.spyOn(
            globalThis,
            "clearInterval"
        );

        const connection = await subscribe(
            ticket.id,
            owner.accessToken
        );

        await connection.nextEvent("comments.snapshot");

        let heartbeatIndex = -1;

        await vi.waitFor(() => {
            heartbeatIndex = intervals.mock.calls.findIndex(
                (args) => args[1] === 15_000
            );

            expect(heartbeatIndex)
                .toBeGreaterThanOrEqual(0);
        });

        const heartbeat =
            intervals.mock.results[heartbeatIndex]?.value;

        expect(heartbeat).toBeDefined();

        connection.close();

        await vi.waitFor(() => {
            expect(clearedIntervals)
                .toHaveBeenCalledWith(heartbeat);
        });

        const replacement = await subscribe(
            ticket.id,
            owner.accessToken
        );

        await replacement.nextEvent("comments.snapshot");

        const response = await createComment(
            ticket.id,
            owner.accessToken
        ).expect(201);

        const event = await replacement.nextEvent(
            "comment.created"
        );

        expect(event.data.data)
            .toEqual(response.body.data);

        expect(connection.events).toHaveLength(0);
    });

    it("should revalidate idle subscriptions through heartbeat authorization", async () => {
        const owner = await createTicketActor("USER");

        const ticket = await createTestTicket({
            requesterId: owner.user.id,
        });

        const connection = await subscribe(
            ticket.id,
            owner.accessToken
        );

        await connection.nextEvent("comments.snapshot");

        await prisma.user.update({
            where: {
                id: owner.user.id,
            },
            data: {
                authVersion: {
                    increment: 1,
                },
            },
        });

        // Exercise the real 15-second heartbeat without
        // creating a comment or mocking application timers.
        const error = await connection.nextEvent(
            "stream.error",
            20_000
        );

        expect(error.data.status).toBe(401);

        await connection.waitUntilClosed();
    }, 25_000);
});