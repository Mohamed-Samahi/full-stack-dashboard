import { prisma } from "../../../config/db.js";
import logger from "../../../config/logger.js";

import {
    getStorageBucket,
} from "../../../config/storage.js";

const ORPHAN_GRACE_PERIOD_MS =
    60 * 60 * 1000;

const CLEANUP_INTERVAL_MS =
    60 * 60 * 1000;

const PAGE_SIZE = 100;

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const removeUnreferencedObject = async (
    storageKey: string
): Promise<boolean> => {
    try {
        const attachment =
            await prisma.ticketAttachment.findUnique({
                where: { storageKey },
                select: { id: true },
            });

        // Protect successfully committed attachments,
        // including ambiguous transaction outcomes.
        if (attachment) {
            return true;
        }

        const { error } = await getStorageBucket()
            .remove([storageKey]);

        if (error) {
            throw new Error("Storage removal failed");
        }

        return true;
    } catch {
        logger.error("Attachment cleanup failed", {
            storageKey,
        });

        return false;
    }
};

const reconcileOrphanedAttachments =
    async (): Promise<void> => {
        const storage = getStorageBucket();

        const cutoff =
            Date.now() - ORPHAN_GRACE_PERIOD_MS;

        let ticketOffset = 0;

        while (true) {
            const { data: folders, error } =
                await storage.list("tickets", {
                    limit: PAGE_SIZE,
                    offset: ticketOffset,
                    sortBy: {
                        column: "name",
                        order: "asc",
                    },
                });

            if (error || !folders) {
                throw new Error("Storage listing failed");
            }

            for (const folder of folders) {
                if (
                    folder.id !== null ||
                    !UUID_PATTERN.test(folder.name)
                ) {
                    continue;
                }

                const prefix = `tickets/${folder.name}`;

                let fileOffset = 0;

                const candidates: string[] = [];

                while (true) {
                    const { data: files, error } =
                        await storage.list(prefix, {
                            limit: PAGE_SIZE,
                            offset: fileOffset,
                            sortBy: {
                                column: "name",
                                order: "asc",
                            },
                        });

                    if (error || !files) {
                        throw new Error(
                            "Storage listing failed"
                        );
                    }

                    for (const file of files) {
                        const createdAt = Date.parse(
                            file.created_at ?? ""
                        );

                        if (
                            file.id &&
                            UUID_PATTERN.test(file.name) &&
                            Number.isFinite(createdAt) &&
                            createdAt < cutoff
                        ) {
                            candidates.push(
                                `${prefix}/${file.name}`
                            );
                        }
                    }

                    if (files.length < PAGE_SIZE) {
                        break;
                    }

                    fileOffset += files.length;
                }

                for (const key of candidates) {
                    await removeUnreferencedObject(key);
                }
            }

            if (folders.length < PAGE_SIZE) {
                break;
            }

            ticketOffset += folders.length;
        }
    };

let cleanupTimer:
    ReturnType<typeof setInterval> | undefined;

let activeCleanup: Promise<void> | undefined;

const runCleanup = (): void => {
    if (activeCleanup) return;

    activeCleanup = reconcileOrphanedAttachments()
        .catch(() => {
            logger.error(
                "Attachment reconciliation failed"
            );
        })
        .finally(() => {
            activeCleanup = undefined;
        });
};

const startAttachmentCleanup = (): void => {
    if (cleanupTimer) return;

    runCleanup();

    cleanupTimer = setInterval(
        runCleanup,
        CLEANUP_INTERVAL_MS
    );

    cleanupTimer.unref();
};

const stopAttachmentCleanup =
    async (): Promise<void> => {
        if (cleanupTimer) {
            clearInterval(cleanupTimer);
            cleanupTimer = undefined;
        }

        await activeCleanup;
    };

export {
    removeUnreferencedObject,
    reconcileOrphanedAttachments,
    startAttachmentCleanup,
    stopAttachmentCleanup,
};