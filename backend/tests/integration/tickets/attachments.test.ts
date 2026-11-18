import { randomUUID } from "node:crypto";

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";

import {
    prisma,
} from "../../../src/config/db.js";

import logger from "../../../src/config/logger.js";

import {
    MAX_ATTACHMENTS,
    SIGNED_URL_TTL_SECONDS,
} from "../../../src/config/storage.js";

import * as ticketService
    from "../../../src/features/tickets/ticket.service.js";

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

import {
    api,
} from "../../helpers/api.helper.js";

import {
    setupIntegrationTests,
} from "../../setup/integration.js";

import {
    PNG,
    INVALID,
} from "../../fixtures/files/attachment.fixtures.js";

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

const SIGNED_URL =
    "https://storage.example.com/signed-download";

const endpoint = "/api/v1/tickets";

const attachmentsEndpoint = (ticketId: string) =>
    `${endpoint}/${ticketId}/attachments`;

const downloadEndpoint = (
    ticketId: string,
    attachmentId: string
) =>
    `${attachmentsEndpoint(ticketId)}/${attachmentId}/download`;

const uploadAttachment = (
    ticketId: string,
    token: string,
    buffer = PNG,
    fileName = "image.png",
    mimeType = "image/png"
) =>
    api
        .post(attachmentsEndpoint(ticketId))
        .set(withAuth(token))
        .attach("file", buffer, {
            filename: fileName,
            contentType: mimeType,
        });

const getAttachments = (
    ticketId: string,
    token: string
) =>
    api
        .get(attachmentsEndpoint(ticketId))
        .set(withAuth(token));

const downloadAttachment = (
    ticketId: string,
    attachmentId: string,
    token: string
) =>
    api
        .get(
            downloadEndpoint(
                ticketId,
                attachmentId
            )
        )
        .set(withAuth(token));

const countAttachments = (ticketId: string) =>
    prisma.ticketAttachment.count({
        where: { ticketId },
    });

const createAttachmentRecord = (
    ticketId: string,
    uploadedById: string,
    overrides: {
        id?: string;
        createdAt?: Date;
    } = {}
) => {
    const id = overrides.id ?? randomUUID();

    return prisma.ticketAttachment.create({
        data: {
            id,
            ticketId,
            uploadedById,
            fileName: "image.png",
            mimeType: "image/png",
            sizeBytes: PNG.length,
            storageKey: `tickets/${ticketId}/${id}`,
            ...overrides,
        },
    });
};

const setupOwnedTicket = async () => {
    const owner = await createTicketActor("USER");

    const ticket = await createTestTicket({
        requesterId: owner.user.id,
        updatedById: owner.user.id,
        updatedAt: new Date("2025-01-01"),
    });

    return { owner, ticket };
};

const deferred = () => {
    let resolve!: () => void;

    const promise = new Promise<void>((done) => {
        resolve = done;
    });

    return { promise, resolve };
};

describe("Ticket Attachments", () => {
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

        storage.createSignedUrl.mockResolvedValue({
            data: {
                signedUrl: SIGNED_URL,
            },
            error: null,
        });

        storage.list.mockResolvedValue({
            data: [],
            error: null,
        });
    });

    // --------------------------------------------
    // Upload authorization and metadata
    // --------------------------------------------

    const creationCases = (
        ["ADMIN", "EMPLOYEE", "USER"] as const
    ).flatMap((role) =>
        (
            ["OPEN", "IN_PROGRESS", "RESOLVED"] as const
        ).map((status) => ({ role, status }))
    );

    it.each(creationCases)(
        "allows $role to upload to accessible $status tickets",
        async ({ role, status }) => {
            const actor = await createTicketActor(role);

            const requester = role === "USER"
                ? actor
                : await createTicketActor("USER");

            const employee = role === "EMPLOYEE"
                ? actor
                : await createTicketActor("EMPLOYEE");

            const ticket = await createTestTicket({
                requesterId: requester.user.id,
                assigneeId: employee.user.id,
                status,
                updatedById: employee.user.id,
                updatedAt: new Date("2025-01-01"),
            });

            const response = await uploadAttachment(
                ticket.id,
                actor.accessToken
            ).expect(201);

            const saved =
                await prisma.ticketAttachment
                    .findUniqueOrThrow({
                        where: {
                            id: response.body.data.id,
                        },
                    });

            expect(saved).toMatchObject({
                ticketId: ticket.id,
                uploadedById: actor.user.id,
                fileName: "image.png",
                mimeType: "image/png",
                sizeBytes: PNG.length,
                storageKey:
                    `tickets/${ticket.id}/${saved.id}`,
            });

            expect(response.body).toEqual({
                data: {
                    id: saved.id,
                    ticketId: ticket.id,
                    fileName: saved.fileName,
                    mimeType: saved.mimeType,
                    sizeBytes: saved.sizeBytes,

                    uploadedBy: {
                        id: actor.user.id,
                        name: actor.user.name,
                    },

                    createdAt:
                        saved.createdAt.toISOString(),
                },
            });

            expect(storage.upload)
                .toHaveBeenCalledExactlyOnceWith(
                    saved.storageKey,
                    PNG,
                    {
                        contentType: "image/png",
                        upsert: false,
                        cacheControl: "0",
                    }
                );

            expect(storage.remove)
                .not.toHaveBeenCalled();

            expect(await getTestTicket(ticket.id))
                .toEqual(ticket);
        }
    );

    it("allows employees to upload to unassigned tickets", async () => {
        const { ticket } = await setupOwnedTicket();

        const employee =
            await createTicketActor("EMPLOYEE");

        await uploadAttachment(
            ticket.id,
            employee.accessToken
        ).expect(201);

        expect(await countAttachments(ticket.id))
            .toBe(1);

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it("generates independent storage keys for identical filenames", async () => {
        const { owner, ticket } =
            await setupOwnedTicket();

        await uploadAttachment(
            ticket.id,
            owner.accessToken
        ).expect(201);

        await uploadAttachment(
            ticket.id,
            owner.accessToken
        ).expect(201);

        const attachments =
            await prisma.ticketAttachment.findMany({
                where: {
                    ticketId: ticket.id,
                },
            });

        expect(attachments).toHaveLength(2);

        expect(
            new Set(
                attachments.map(
                    (item) => item.storageKey
                )
            ).size
        ).toBe(2);

        expect(
            attachments.every(
                (item) =>
                    item.fileName === "image.png"
            )
        ).toBe(true);
    });

    it("rejects invalid content without contacting storage", async () => {
        const { owner, ticket } =
            await setupOwnedTicket();

        await uploadAttachment(
            ticket.id,
            owner.accessToken,
            INVALID
        ).expect(415);

        expect(storage.upload)
            .not.toHaveBeenCalled();

        expect(await countAttachments(ticket.id))
            .toBe(0);

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it("rejects empty files without contacting storage", async () => {
        const { owner, ticket } =
            await setupOwnedTicket();

        await uploadAttachment(
            ticket.id,
            owner.accessToken,
            Buffer.alloc(0)
        ).expect(400);

        expect(storage.upload)
            .not.toHaveBeenCalled();
    });

    // --------------------------------------------
    // Retrieval and signed downloads
    // --------------------------------------------

    it("returns an empty attachment collection", async () => {
        const { owner, ticket } =
            await setupOwnedTicket();

        const response = await getAttachments(
            ticket.id,
            owner.accessToken
        ).expect(200);

        expect(response.body).toEqual({
            data: [],
        });

        expect(storage.list)
            .not.toHaveBeenCalled();

        expect(storage.createSignedUrl)
            .not.toHaveBeenCalled();
    });

    it("returns only ticket attachments in deterministic order", async () => {
        const { owner, ticket } =
            await setupOwnedTicket();

        const other = await createTestTicket({
            requesterId: owner.user.id,
        });

        const firstId =
            "00000000-0000-4000-8000-000000000001";

        const secondId =
            "00000000-0000-4000-8000-000000000002";

        const createdAt =
            new Date("2025-01-01");

        const third = await createAttachmentRecord(
            ticket.id,
            owner.user.id,
            {
                createdAt: new Date("2025-01-02"),
            }
        );

        await createAttachmentRecord(
            ticket.id,
            owner.user.id,
            {
                id: secondId,
                createdAt,
            }
        );

        await createAttachmentRecord(
            ticket.id,
            owner.user.id,
            {
                id: firstId,
                createdAt,
            }
        );

        await createAttachmentRecord(
            other.id,
            owner.user.id
        );

        const response = await getAttachments(
            ticket.id,
            owner.accessToken
        ).expect(200);

        expect(
            response.body.data.map(
                (item: { id: string }) => item.id
            )
        ).toEqual([
            firstId,
            secondId,
            third.id,
        ]);

        expect(response.body.data[0])
            .not.toHaveProperty("storageKey");

        expect(response.body.data[0])
            .not.toHaveProperty("uploadedById");

        expect(storage.list)
            .not.toHaveBeenCalled();

        expect(storage.createSignedUrl)
            .not.toHaveBeenCalled();
    });

    it("generates a short-lived forced-download URL without caching", async () => {
        const { owner, ticket } =
            await setupOwnedTicket();

        const attachment =
            await createAttachmentRecord(
                ticket.id,
                owner.user.id
            );

        const before = Date.now();

        const response =
            await downloadAttachment(
                ticket.id,
                attachment.id,
                owner.accessToken
            ).expect(200);

        const after = Date.now();

        expect(storage.createSignedUrl)
            .toHaveBeenCalledExactlyOnceWith(
                attachment.storageKey,
                SIGNED_URL_TTL_SECONDS,
                {
                    download: attachment.fileName,
                }
            );

        expect(SIGNED_URL_TTL_SECONDS).toBe(60);

        expect(response.body.data.downloadUrl)
            .toBe(SIGNED_URL);

        const expiresAt = Date.parse(
            response.body.data.expiresAt
        );

        expect(expiresAt)
            .toBeGreaterThanOrEqual(
                before + 60_000
            );

        expect(expiresAt)
            .toBeLessThanOrEqual(
                after + 60_000
            );

        expect(response.headers["cache-control"])
            .toContain("no-store");

        expect(response.headers["cache-control"])
            .toContain("private");

        expect(response.body.data)
            .not.toHaveProperty("storageKey");

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);

        expect(
            await prisma.ticketAttachment
                .findUniqueOrThrow({
                    where: {
                        id: attachment.id,
                    },
                })
        ).toEqual(attachment);
    });

    it("rejects cross-ticket attachment access", async () => {
        const { owner, ticket } =
            await setupOwnedTicket();

        const other = await createTestTicket({
            requesterId: owner.user.id,
        });

        const attachment =
            await createAttachmentRecord(
                other.id,
                owner.user.id
            );

        await downloadAttachment(
            ticket.id,
            attachment.id,
            owner.accessToken
        ).expect(404);

        expect(storage.createSignedUrl)
            .not.toHaveBeenCalled();
    });

    it("rejects nonexistent attachments", async () => {
        const { owner, ticket } =
            await setupOwnedTicket();

        await downloadAttachment(
            ticket.id,
            randomUUID(),
            owner.accessToken
        ).expect(404);

        expect(storage.createSignedUrl)
            .not.toHaveBeenCalled();
    });

    // --------------------------------------------
    // Authentication and resource authorization
    // --------------------------------------------

    it("requires authentication for all attachment operations", async () => {
        const { ticket } = await setupOwnedTicket();

        await api
            .post(attachmentsEndpoint(ticket.id))
            .attach("file", PNG, "image.png")
            .expect(401);

        await api
            .get(attachmentsEndpoint(ticket.id))
            .expect(401);

        await api
            .get(
                downloadEndpoint(
                    ticket.id,
                    randomUUID()
                )
            )
            .expect(401);

        expect(storage.upload)
            .not.toHaveBeenCalled();

        expect(storage.createSignedUrl)
            .not.toHaveBeenCalled();
    });

    it("requires ticket:attach for uploads", async () => {
        const { user } = await createTestUser({
            role: "USER",
            permissions: ["ticket:read"],
        });

        const token =
            await createTestAccessToken(user.id);

        const ticket = await createTestTicket({
            requesterId: user.id,
        });

        await uploadAttachment(
            ticket.id,
            token
        ).expect(403);

        await getAttachments(
            ticket.id,
            token
        ).expect(200);

        expect(storage.upload)
            .not.toHaveBeenCalled();
    });

    it("requires ticket:read for metadata and downloads", async () => {
        const { user } = await createTestUser({
            role: "USER",
            permissions: ["ticket:attach"],
        });

        const token =
            await createTestAccessToken(user.id);

        const ticket = await createTestTicket({
            requesterId: user.id,
        });

        const attachment =
            await createAttachmentRecord(
                ticket.id,
                user.id
            );

        await getAttachments(
            ticket.id,
            token
        ).expect(403);

        await downloadAttachment(
            ticket.id,
            attachment.id,
            token
        ).expect(403);

        expect(storage.createSignedUrl)
            .not.toHaveBeenCalled();
    });

    it("conceals inaccessible and nonexistent tickets", async () => {
        const { owner, ticket } =
            await setupOwnedTicket();

        const other =
            await createTicketActor("USER");

        const attachment =
            await createAttachmentRecord(
                ticket.id,
                owner.user.id
            );

        await uploadAttachment(
            ticket.id,
            other.accessToken
        ).expect(404);

        await getAttachments(
            ticket.id,
            other.accessToken
        ).expect(404);

        await downloadAttachment(
            ticket.id,
            attachment.id,
            other.accessToken
        ).expect(404);

        const missing = randomUUID();

        await uploadAttachment(
            missing,
            owner.accessToken
        ).expect(404);

        await getAttachments(
            missing,
            owner.accessToken
        ).expect(404);

        await downloadAttachment(
            missing,
            attachment.id,
            owner.accessToken
        ).expect(404);

        expect(storage.upload)
            .not.toHaveBeenCalled();

        expect(storage.createSignedUrl)
            .not.toHaveBeenCalled();
    });

    it("rejects malformed identifiers", async () => {
        const { owner, ticket } =
            await setupOwnedTicket();

        await uploadAttachment(
            "invalid-id",
            owner.accessToken
        ).expect(400);

        await getAttachments(
            "invalid-id",
            owner.accessToken
        ).expect(400);

        await downloadAttachment(
            ticket.id,
            "invalid-id",
            owner.accessToken
        ).expect(400);

        expect(storage.upload)
            .not.toHaveBeenCalled();

        expect(storage.createSignedUrl)
            .not.toHaveBeenCalled();
    });

    it("revokes assignment-based access following reassignment", async () => {
        const admin =
            await createTicketActor("ADMIN");

        const owner =
            await createTicketActor("USER");

        const first =
            await createTicketActor("EMPLOYEE");

        const second =
            await createTicketActor("EMPLOYEE");

        const ticket = await createTestTicket({
            requesterId: owner.user.id,
            assigneeId: first.user.id,
        });

        const attachment =
            await createAttachmentRecord(
                ticket.id,
                first.user.id
            );

        await api
            .patch(
                `${endpoint}/${ticket.id}/assignment`
            )
            .set(withAuth(admin.accessToken))
            .send({
                assigneeId: second.user.id,
            })
            .expect(200);

        await getAttachments(
            ticket.id,
            first.accessToken
        ).expect(404);

        await uploadAttachment(
            ticket.id,
            first.accessToken
        ).expect(404);

        await downloadAttachment(
            ticket.id,
            attachment.id,
            first.accessToken
        ).expect(404);

        await getAttachments(
            ticket.id,
            second.accessToken
        ).expect(200);

        await downloadAttachment(
            ticket.id,
            attachment.id,
            second.accessToken
        ).expect(200);
    });

    // --------------------------------------------
    // CLOSED ticket immutability
    // --------------------------------------------

    it.each(["ADMIN", "EMPLOYEE", "USER"] as const)(
        "allows %s to read but not modify CLOSED tickets",
        async (role) => {
            const actor =
                await createTicketActor(role);

            const ticket = await createTestTicket({
                requesterId: actor.user.id,
                status: "CLOSED",
                updatedById: actor.user.id,
                updatedAt: new Date("2025-01-01"),
            });

            const attachment =
                await createAttachmentRecord(
                    ticket.id,
                    actor.user.id
                );

            await uploadAttachment(
                ticket.id,
                actor.accessToken
            ).expect(409);

            await getAttachments(
                ticket.id,
                actor.accessToken
            ).expect(200);

            await downloadAttachment(
                ticket.id,
                attachment.id,
                actor.accessToken
            ).expect(200);

            expect(storage.upload)
                .not.toHaveBeenCalled();

            expect(await countAttachments(ticket.id))
                .toBe(1);

            expect(await getTestTicket(ticket.id))
                .toEqual(ticket);
        }
    );

    // --------------------------------------------
    // Concurrent operations
    // --------------------------------------------

    it("enforces the configured attachment limit", async () => {
        const { owner, ticket } =
            await setupOwnedTicket();

        for (
            let index = 0;
            index < MAX_ATTACHMENTS;
            index++
        ) {
            await createAttachmentRecord(
                ticket.id,
                owner.user.id
            );
        }

        await uploadAttachment(
            ticket.id,
            owner.accessToken
        ).expect(409);

        expect(storage.upload)
            .not.toHaveBeenCalled();

        expect(await countAttachments(ticket.id))
            .toBe(MAX_ATTACHMENTS);
    });

    it("prevents concurrent uploads exceeding the attachment limit", async () => {
        const { owner, ticket } =
            await setupOwnedTicket();

        for (
            let index = 0;
            index < MAX_ATTACHMENTS - 1;
            index++
        ) {
            await createAttachmentRecord(
                ticket.id,
                owner.user.id
            );
        }

        const bothUploading = deferred();
        const releaseUploads = deferred();

        let arrivals = 0;

        storage.upload.mockImplementation(
            async () => {
                arrivals++;

                if (arrivals === 2) {
                    bothUploading.resolve();
                }

                await releaseUploads.promise;

                return {
                    data: {},
                    error: null,
                };
            }
        );

        const pending = [
            uploadAttachment(
                ticket.id,
                owner.accessToken
            ).then((result) => result),

            uploadAttachment(
                ticket.id,
                owner.accessToken
            ).then((result) => result),
        ];

        try {
            await bothUploading.promise;
        } finally {
            releaseUploads.resolve();
        }

        const responses =
            await Promise.all(pending);

        expect(
            responses.map(
                (response) => response.status
            ).sort()
        ).toEqual([201, 409]);

        expect(await countAttachments(ticket.id))
            .toBe(MAX_ATTACHMENTS);

        expect(storage.upload)
            .toHaveBeenCalledTimes(2);

        expect(storage.remove)
            .toHaveBeenCalledTimes(1);

        const removedKey =
            storage.remove.mock.calls[0]?.[0]?.[0];

        expect(
            await prisma.ticketAttachment.findUnique({
                where: {
                    storageKey: removedKey,
                },
            })
        ).toBeNull();

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it("rejects attachment persistence when a ticket closes during upload", async () => {
        const owner =
            await createTicketActor("USER");

        const ticket = await createTestTicket({
            requesterId: owner.user.id,
            status: "RESOLVED",
        });

        const uploading = deferred();
        const releaseUpload = deferred();

        storage.upload.mockImplementationOnce(
            async () => {
                uploading.resolve();

                await releaseUpload.promise;

                return {
                    data: {},
                    error: null,
                };
            }
        );

        const pendingUpload = uploadAttachment(
            ticket.id,
            owner.accessToken
        ).then((result) => result);

        let closed;

        try {
            await uploading.promise;

            await api
                .patch(
                    `${endpoint}/${ticket.id}/status`
                )
                .set(withAuth(owner.accessToken))
                .send({
                    status: "CLOSED",
                })
                .expect(200);

            closed = await getTestTicket(ticket.id);
        } finally {
            releaseUpload.resolve();
        }

        const result = await pendingUpload;

        expect(result.status).toBe(409);

        expect(await countAttachments(ticket.id))
            .toBe(0);

        expect(storage.remove)
            .toHaveBeenCalledExactlyOnceWith([
                storage.upload.mock.calls[0]?.[0],
            ]);

        expect(await getTestTicket(ticket.id))
            .toEqual(closed);
    });

    it("revalidates assignment-based authorization after external upload", async () => {
        const admin =
            await createTicketActor("ADMIN");

        const owner =
            await createTicketActor("USER");

        const first =
            await createTicketActor("EMPLOYEE");

        const second =
            await createTicketActor("EMPLOYEE");

        const ticket = await createTestTicket({
            requesterId: owner.user.id,
            assigneeId: first.user.id,
        });

        const uploading = deferred();
        const releaseUpload = deferred();

        storage.upload.mockImplementationOnce(
            async () => {
                uploading.resolve();

                await releaseUpload.promise;

                return {
                    data: {},
                    error: null,
                };
            }
        );

        const pending = uploadAttachment(
            ticket.id,
            first.accessToken
        ).then((result) => result);

        let reassigned;

        try {
            await uploading.promise;

            await api
                .patch(
                    `${endpoint}/${ticket.id}/assignment`
                )
                .set(withAuth(admin.accessToken))
                .send({
                    assigneeId: second.user.id,
                })
                .expect(200);

            reassigned =
                await getTestTicket(ticket.id);
        } finally {
            releaseUpload.resolve();
        }

        expect((await pending).status).toBe(404);

        expect(await countAttachments(ticket.id))
            .toBe(0);

        expect(storage.remove)
            .toHaveBeenCalledTimes(1);

        expect(await getTestTicket(ticket.id))
            .toEqual(reassigned);
    });

    // --------------------------------------------
    // Storage failures
    // --------------------------------------------

    it("handles storage upload failures without persisting metadata", async () => {
        const { owner, ticket } =
            await setupOwnedTicket();

        storage.upload.mockResolvedValueOnce({
            data: null,
            error: {
                message: "Sensitive provider error",
            },
        });

        const response = await uploadAttachment(
            ticket.id,
            owner.accessToken
        ).expect(503);

        expect(response.body).toEqual({
            status: "error",
            message: "Storage upload failed",
        });

        expect(await countAttachments(ticket.id))
            .toBe(0);

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);

        expect(storage.remove)
            .toHaveBeenCalledTimes(1);
    });

    it("handles rejected storage operations", async () => {
        const { owner, ticket } =
            await setupOwnedTicket();

        storage.upload.mockRejectedValueOnce(
            new Error("Storage timeout")
        );

        await uploadAttachment(
            ticket.id,
            owner.accessToken
        ).expect(503);

        expect(await countAttachments(ticket.id))
            .toBe(0);

        expect(storage.remove)
            .toHaveBeenCalledTimes(1);
    });

    it("sanitizes signed URL generation failures", async () => {
        const { owner, ticket } =
            await setupOwnedTicket();

        const attachment =
            await createAttachmentRecord(
                ticket.id,
                owner.user.id
            );

        storage.createSignedUrl
            .mockRejectedValueOnce(
                new Error("Sensitive provider error")
            );

        const response =
            await downloadAttachment(
                ticket.id,
                attachment.id,
                owner.accessToken
            ).expect(503);

        expect(response.body).toEqual({
            status: "error",
            message: "Storage download unavailable",
        });

        expect(await countAttachments(ticket.id))
            .toBe(1);

        expect(storage.remove)
            .not.toHaveBeenCalled();
    });

    // --------------------------------------------
    // Database failure and ambiguous commits
    // --------------------------------------------

    it("compensates when attachment metadata persistence rolls back", async () => {
        const { owner, ticket } =
            await setupOwnedTicket();

        const original =
            ticketService.withTicketTransaction;

        let calls = 0;

        vi.spyOn(
            ticketService,
            "withTicketTransaction"
        ).mockImplementation(
            async (operation) => {
                calls++;

                // 1: initial route authorization
                // 2: service authorization
                // 3: attachment persistence
                if (calls === 3) {
                    return original(async (tx) => {
                        await operation(tx);

                        throw new Error(
                            "Simulated database rollback"
                        );
                    });
                }

                return original(operation);
            }
        );

        await uploadAttachment(
            ticket.id,
            owner.accessToken
        ).expect(500);

        expect(await countAttachments(ticket.id))
            .toBe(0);

        expect(storage.remove)
            .toHaveBeenCalledExactlyOnceWith([
                storage.upload.mock.calls[0]?.[0],
            ]);

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it("protects successfully committed metadata after an ambiguous commit error", async () => {
        const { owner, ticket } =
            await setupOwnedTicket();

        const original =
            ticketService.withTicketTransaction;

        let calls = 0;

        vi.spyOn(
            ticketService,
            "withTicketTransaction"
        ).mockImplementation(
            async (operation) => {
                calls++;

                if (calls === 3) {
                    // Commit succeeds in PostgreSQL,
                    // but the application sees failure.
                    await original(operation);

                    throw new Error(
                        "Simulated lost commit acknowledgement"
                    );
                }

                return original(operation);
            }
        );

        await uploadAttachment(
            ticket.id,
            owner.accessToken
        ).expect(500);

        expect(await countAttachments(ticket.id))
            .toBe(1);

        const persisted =
            await prisma.ticketAttachment
                .findFirstOrThrow({
                    where: {
                        ticketId: ticket.id,
                    },
                });

        expect(persisted.storageKey)
            .toBe(
                storage.upload.mock.calls[0]?.[0]
            );

        expect(storage.remove)
            .not.toHaveBeenCalled();

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it("defers compensation when storage removal fails", async () => {
        const { owner, ticket } =
            await setupOwnedTicket();

        const log = vi.spyOn(
            logger,
            "error"
        );

        storage.upload.mockRejectedValueOnce(
            new Error("Upload failed")
        );

        storage.remove.mockResolvedValueOnce({
            data: null,
            error: {
                message: "Removal unavailable",
            },
        });

        await uploadAttachment(
            ticket.id,
            owner.accessToken
        ).expect(503);

        expect(log).toHaveBeenCalledWith(
            "Attachment cleanup deferred",
            {
                storageKey:
                    storage.upload.mock.calls[0]?.[0],
            }
        );

        expect(await countAttachments(ticket.id))
            .toBe(0);

        expect(await getTestTicket(ticket.id))
            .toEqual(ticket);
    });

    it("restricts deletion of referenced tickets and uploaders", async () => {
        const { owner, ticket } =
            await setupOwnedTicket();

        const uploader =
            await createTicketActor("EMPLOYEE");

        await createAttachmentRecord(
            ticket.id,
            uploader.user.id
        );

        await expect(
            prisma.ticket.delete({
                where: { id: ticket.id },
            })
        ).rejects.toMatchObject({
            code: "P2003",
        });

        await expect(
            prisma.user.delete({
                where: {
                    id: uploader.user.id,
                },
            })
        ).rejects.toMatchObject({
            code: "P2003",
        });

        expect(await countAttachments(ticket.id))
            .toBe(1);

        expect(owner.user.id)
            .toBe(ticket.requesterId);
    });

    it.each([
        {
            sizeBytes: 0,
            fileName: "image.png",
        },
        {
            sizeBytes: -1,
            fileName: "image.png",
        },
        {
            sizeBytes: 1,
            fileName: "",
        },
    ])(
        "enforces attachment metadata database constraints",
        async ({ sizeBytes, fileName }) => {
            const { owner, ticket } =
                await setupOwnedTicket();

            const id = randomUUID();

            await expect(
                prisma.$executeRaw`
                    INSERT INTO "TicketAttachment" (
                        "id",
                        "ticketId",
                        "uploadedById",
                        "fileName",
                        "storageKey",
                        "mimeType",
                        "sizeBytes"
                    )
                    VALUES (
                        ${id},
                        ${ticket.id},
                        ${owner.user.id},
                        ${fileName},
                        ${`tickets/${ticket.id}/${id}`},
                        ${"image/png"},
                        ${sizeBytes}
                    )
                `
            ).rejects.toMatchObject({
                code: "P2010",
            });

            expect(
                await countAttachments(ticket.id)
            ).toBe(0);
        }
    );
});