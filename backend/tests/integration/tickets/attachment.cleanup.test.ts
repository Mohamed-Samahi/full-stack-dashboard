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

import * as ticketService
    from "../../../src/features/tickets/ticket.service.js";

import {
    removeUnreferencedObject,
    reconcileOrphanedAttachments,
    startAttachmentCleanup,
    stopAttachmentCleanup,
} from "../../../src/features/tickets/attachments/attachment.cleanup.js";

import {
    createTicketActor,
    createTestTicket,
} from "../../factories/ticket.factory.js";

import {
    setupIntegrationTests,
} from "../../setup/integration.js";

const storage = vi.hoisted(() => ({
    remove: vi.fn(),
    list: vi.fn(),
}));

vi.mock(
    "../../../src/config/storage.js",
    async (importOriginal) => ({
        ...await importOriginal<object>(),
        getStorageBucket: () => storage,
    })
);

const deferred = () => {
    let resolve!: () => void;

    const promise = new Promise<void>((done) => {
        resolve = done;
    });

    return { promise, resolve };
};

const createContext = async () => {
    const actor =
        await createTicketActor("USER");

    const ticket =
        await createTestTicket({
            requesterId: actor.user.id,
        });

    const id = randomUUID();

    const storageKey =
        `tickets/${ticket.id}/${id}`;

    const data = {
        id,
        storageKey,
        ticketId: ticket.id,
        uploadedById: actor.user.id,
        fileName: "image.png",
        mimeType: "image/png",
        sizeBytes: 100,
    };

    return {
        actor,
        ticket,
        id,
        storageKey,
        data,
    };
};

const oldTimestamp = () =>
    new Date(
        Date.now() - 2 * 60 * 60 * 1000
    ).toISOString();

describe("Attachment cleanup and reconciliation", () => {
    setupIntegrationTests();

    beforeEach(() => {
        storage.remove.mockReset();
        storage.list.mockReset();

        storage.remove.mockResolvedValue({
            data: [],
            error: null,
        });

        storage.list.mockResolvedValue({
            data: [],
            error: null,
        });
    });

    it("removes an unreferenced storage object", async () => {
        const { storageKey } =
            await createContext();

        await expect(
            removeUnreferencedObject(storageKey)
        ).resolves.toBe(true);

        expect(storage.remove)
            .toHaveBeenCalledExactlyOnceWith([
                storageKey,
            ]);
    });

    it("protects an already committed attachment", async () => {
        const { data, storageKey } =
            await createContext();

        await prisma.ticketAttachment.create({
            data,
        });

        await expect(
            removeUnreferencedObject(storageKey)
        ).resolves.toBe(true);

        expect(storage.remove)
            .not.toHaveBeenCalled();
    });

    it("defers deletion when database state is unavailable", async () => {
        const { storageKey } =
            await createContext();

        vi.spyOn(
            ticketService,
            "withTicketTransaction"
        ).mockRejectedValueOnce(
            new Error("Database unavailable")
        );

        const log =
            vi.spyOn(logger, "error");

        await expect(
            removeUnreferencedObject(storageKey)
        ).resolves.toBe(false);

        expect(storage.remove)
            .not.toHaveBeenCalled();

        expect(log).toHaveBeenCalledWith(
            "Attachment cleanup deferred",
            { storageKey }
        );
    });

    it("defers deletion when storage removal fails", async () => {
        const { storageKey } =
            await createContext();

        storage.remove.mockResolvedValueOnce({
            data: null,
            error: {
                message: "Provider unavailable",
            },
        });

        await expect(
            removeUnreferencedObject(storageKey)
        ).resolves.toBe(false);

        expect(storage.remove)
            .toHaveBeenCalledTimes(1);

        await expect(
            removeUnreferencedObject(storageKey)
        ).resolves.toBe(true);

        expect(storage.remove)
            .toHaveBeenCalledTimes(2);
    });

    // --------------------------------------------
    // Actual database transaction synchronization
    // --------------------------------------------

    it.each([
        "commit",
        "rollback",
    ] as const)(
        "waits for an in-flight transaction to %s before compensation",
        async (outcome) => {
            const { data, storageKey } =
                await createContext();

            const inserted = deferred();
            const releaseTransaction = deferred();

            const persistence =
                ticketService.withTicketTransaction(
                    async (tx) => {
                        await tx.ticketAttachment.create({
                            data,
                        });

                        inserted.resolve();

                        await releaseTransaction.promise;

                        if (outcome === "rollback") {
                            throw new Error(
                                "Deliberate rollback"
                            );
                        }
                    }
                ).then(
                    () => "committed",
                    () => "rolled-back"
                );

            await inserted.promise;

            let cleanupCompleted = false;

            const cleanup =
                removeUnreferencedObject(
                    storageKey
                ).then((result) => {
                    cleanupCompleted = true;
                    return result;
                });

            try {
                // Confirm another PostgreSQL session
                // is waiting for an advisory lock.
                await vi.waitFor(
                    async () => {
                        const rows =
                            await prisma.$queryRaw<
                                { waiting: bigint }[]
                            >`
                                SELECT count(*) AS waiting
                                FROM pg_locks
                                WHERE locktype = 'advisory'
                                  AND NOT granted
                                  AND database = (
                                    SELECT oid
                                    FROM pg_database
                                    WHERE datname =
                                        current_database()
                                  )
                            `;

                        expect(
                            Number(rows[0]?.waiting)
                        ).toBeGreaterThan(0);
                    },
                    {
                        timeout: 3000,
                        interval: 25,
                    }
                );

                expect(cleanupCompleted)
                    .toBe(false);

                expect(storage.remove)
                    .not.toHaveBeenCalled();
            } finally {
                releaseTransaction.resolve();

                await Promise.all([
                    persistence,
                    cleanup,
                ]);
            }

            expect(await cleanup).toBe(true);

            const record =
                await prisma.ticketAttachment
                    .findUnique({
                        where: { storageKey },
                    });

            if (outcome === "commit") {
                expect(await persistence)
                    .toBe("committed");

                expect(record)
                    .not.toBeNull();

                expect(storage.remove)
                    .not.toHaveBeenCalled();
            } else {
                expect(await persistence)
                    .toBe("rolled-back");

                expect(record)
                    .toBeNull();

                expect(storage.remove)
                    .toHaveBeenCalledExactlyOnceWith([
                        storageKey,
                    ]);
            }
        }
    );

    // --------------------------------------------
    // Orphan reconciliation
    // --------------------------------------------

    it("removes only old, valid, unreferenced objects", async () => {
        const {
            ticket,
            id,
            data,
        } = await createContext();

        await prisma.ticketAttachment.create({
            data,
        });

        const orphanId = randomUUID();
        const recentId = randomUUID();
        const invalidTimestampId = randomUUID();

        const prefix = `tickets/${ticket.id}`;

        storage.list.mockImplementation(
            async (path: string) => {
                if (path === "tickets") {
                    return {
                        data: [
                            {
                                id: null,
                                name: ticket.id,
                            },
                            {
                                id: null,
                                name: "invalid-folder",
                            },
                        ],
                        error: null,
                    };
                }

                if (path === prefix) {
                    return {
                        data: [
                            {
                                id: randomUUID(),
                                name: id,
                                created_at: oldTimestamp(),
                            },
                            {
                                id: randomUUID(),
                                name: orphanId,
                                created_at: oldTimestamp(),
                            },
                            {
                                id: randomUUID(),
                                name: recentId,
                                created_at:
                                    new Date().toISOString(),
                            },
                            {
                                id: randomUUID(),
                                name: invalidTimestampId,
                                created_at: "invalid",
                            },
                            {
                                id: randomUUID(),
                                name: "unexpected-file.txt",
                                created_at: oldTimestamp(),
                            },
                            {
                                id: null,
                                name: randomUUID(),
                                created_at: oldTimestamp(),
                            },
                        ],
                        error: null,
                    };
                }

                throw new Error(
                    "Unexpected storage path"
                );
            }
        );

        await reconcileOrphanedAttachments();

        expect(storage.remove)
            .toHaveBeenCalledExactlyOnceWith([
                `${prefix}/${orphanId}`,
            ]);

        expect(
            await prisma.ticketAttachment
                .findUnique({
                    where: { id },
                })
        ).not.toBeNull();

        expect(storage.list)
            .toHaveBeenCalledTimes(2);
    });

    it("handles paginated object listings without skipping candidates", async () => {
        const { ticket } =
            await createContext();

        const prefix = `tickets/${ticket.id}`;

        const files = Array.from(
            { length: 101 },
            () => ({
                id: randomUUID(),
                name: randomUUID(),
                created_at: oldTimestamp(),
            })
        );

        storage.list.mockImplementation(
            async (
                path: string,
                options: {
                    offset: number;
                    limit: number;
                }
            ) => {
                if (path === "tickets") {
                    return {
                        data: [
                            {
                                id: null,
                                name: ticket.id,
                            },
                        ],
                        error: null,
                    };
                }

                return {
                    data: files.slice(
                        options.offset,
                        options.offset + options.limit
                    ),
                    error: null,
                };
            }
        );

        await reconcileOrphanedAttachments();

        expect(storage.remove)
            .toHaveBeenCalledTimes(101);

        expect(storage.list)
            .toHaveBeenCalledWith(
                prefix,
                expect.objectContaining({
                    limit: 100,
                    offset: 100,
                })
            );

        expect(
            new Set(
                storage.remove.mock.calls.map(
                    ([keys]) => keys[0]
                )
            ).size
        ).toBe(101);
    });

    it("retries previously failed orphan cleanup during reconciliation", async () => {
        const {
            ticket,
            id,
            storageKey,
        } = await createContext();

        storage.remove.mockResolvedValueOnce({
            data: null,
            error: {
                message: "Temporary storage failure",
            },
        });

        await expect(
            removeUnreferencedObject(storageKey)
        ).resolves.toBe(false);

        storage.list.mockImplementation(
            async (path: string) => ({
                data: path === "tickets"
                    ? [
                        {
                            id: null,
                            name: ticket.id,
                        },
                    ]
                    : [
                        {
                            id: randomUUID(),
                            name: id,
                            created_at: oldTimestamp(),
                        },
                    ],

                error: null,
            })
        );

        await reconcileOrphanedAttachments();

        expect(storage.remove)
            .toHaveBeenCalledTimes(2);

        expect(storage.remove)
            .toHaveBeenLastCalledWith([
                storageKey,
            ]);
    });

    it("does not remove objects when storage listing fails", async () => {
        storage.list.mockResolvedValueOnce({
            data: null,
            error: {
                message: "Listing unavailable",
            },
        });

        await expect(
            reconcileOrphanedAttachments()
        ).rejects.toThrow(
            "Storage listing failed"
        );

        expect(storage.remove)
            .not.toHaveBeenCalled();
    });

    it("starts cleanup immediately without duplicating active runs", async () => {
        const listing = deferred();

        storage.list.mockImplementationOnce(
            async () => {
                await listing.promise;

                return {
                    data: [],
                    error: null,
                };
            }
        );

        try {
            startAttachmentCleanup();
            startAttachmentCleanup();

            expect(storage.list)
                .toHaveBeenCalledTimes(1);
        } finally {
            listing.resolve();

            await stopAttachmentCleanup();
        }
    });

    it("handles reconciliation failures during the cleanup lifecycle", async () => {
        const log =
            vi.spyOn(logger, "error");

        storage.list.mockRejectedValueOnce(
            new Error("Storage unavailable")
        );

        try {
            startAttachmentCleanup();
        } finally {
            await stopAttachmentCleanup();
        }

        expect(log).toHaveBeenCalledWith(
            "Attachment reconciliation failed"
        );
    });
});