import type { Prisma } from "../../generated/prisma/client.js";

const lockRbacConfiguration = async (
    tx: Prisma.TransactionClient
): Promise<void> => {
    await tx.$queryRaw`
        SELECT 1 AS acquired
        FROM (
            SELECT pg_advisory_xact_lock(
                hashtextextended('rbac:configuration', 0)
            )
        ) AS lock_guard
    `;
};

export { lockRbacConfiguration };