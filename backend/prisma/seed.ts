import "dotenv/config";

import { createClient } from "redis";

import { prisma } from "../src/config/db.js";

import {
    PREDEFINED_ROLES,
    PERMISSION_DEFINITIONS,
    ROLE_PERMISSIONS,
} from "../src/features/rbac/rbac.constants.js";

import {
    lockRbacConfiguration,
} from "../src/features/rbac/rbac.lock.js";

import {
    deleteRoleVersion,
} from "../src/utils/authVersion.js";

const seedRbac = async () => {
    return prisma.$transaction(async (tx) => {
        await lockRbacConfiguration(tx);

        const permissionMap = new Map<string, string>();

        // 1. Synchronize supported permission definitions.
        for (const [key, description] of Object.entries(
            PERMISSION_DEFINITIONS
        )) {
            const permission = await tx.permission.upsert({
                where: { key },
                update: { description },
                create: { key, description },
                select: { id: true },
            });

            permissionMap.set(key, permission.id);
        }

        const roleIds: string[] = [];

        // 2. Synchronize predefined roles and permission mappings.
        for (const roleName of PREDEFINED_ROLES) {
            const role = await tx.role.upsert({
                where: {
                    name: roleName,
                },
                update: {},
                create: {
                    name: roleName,
                },
                select: {
                    id: true,
                },
            });

            roleIds.push(role.id);

            const requiredPermissionIds = ROLE_PERMISSIONS[
                roleName
            ].map((key) => {
                const permissionId = permissionMap.get(key);

                if (!permissionId) {
                    throw new Error(
                        `Permission '${key}' is not configured`
                    );
                }

                return permissionId;
            });

            const currentMappings =
                await tx.rolePermission.findMany({
                    where: {
                        roleId: role.id,
                    },
                    select: {
                        permissionId: true,
                    },
                });

            const currentIds = new Set(
                currentMappings.map(
                    (mapping) => mapping.permissionId
                )
            );

            const requiredIds = new Set(requiredPermissionIds);

            const obsoleteIds = [...currentIds].filter(
                (id) => !requiredIds.has(id)
            );

            const missingIds = requiredPermissionIds.filter(
                (id) => !currentIds.has(id)
            );

            // Unchanged permissions must preserve authVersion.
            if (
                obsoleteIds.length === 0 &&
                missingIds.length === 0
            ) {
                continue;
            }

            // 3. Remove obsolete mappings.
            if (obsoleteIds.length > 0) {
                await tx.rolePermission.deleteMany({
                    where: {
                        roleId: role.id,
                        permissionId: {
                            in: obsoleteIds,
                        },
                    },
                });
            }

            // 4. Insert missing mappings.
            if (missingIds.length > 0) {
                await tx.rolePermission.createMany({
                    data: missingIds.map((permissionId) => ({
                        roleId: role.id,
                        permissionId,
                    })),
                });
            }

            // 5. Atomically invalidate existing access tokens.
            await tx.role.update({
                where: {
                    id: role.id,
                },
                data: {
                    authVersion: {
                        increment: 1,
                    },
                },
            });
        }

        return roleIds;
    }, {
        maxWait: 10000,
        timeout: 30000,
    });
};

const main = async () => {
    const redisUrl = process.env.REDIS_URL;

    if (!redisUrl) {
        throw new Error("REDIS_URL is not defined");
    }

    // PostgreSQL changes must commit before cache invalidation.
    const roleIds = await seedRbac();

    console.log("RBAC database synchronization completed.");

    // Dedicated CLI connection without indefinite reconnection.
    const cacheClient = createClient({
        url: redisUrl,
        disableOfflineQueue: true,
        socket: {
            connectTimeout: 5000,
            reconnectStrategy: false,
        },
    });

    cacheClient.on("error", () => {
        console.error("Redis connection error during RBAC seeding.");
    });

    try {
        await cacheClient.connect();

        // Invalidate all predefined roles, including unchanged
        // roles, so reruns can recover from previous failures.
        for (const roleId of roleIds) {
            await deleteRoleVersion(roleId, cacheClient);
        }

        console.log("RBAC cache invalidation completed.");
    } catch {
        console.error(
            "Database changes committed, but Redis invalidation failed."
        );

        console.error(
            "Access-token verification remains protected by PostgreSQL. "
            + "Rerun the seed after restoring Redis."
        );

        process.exitCode = 1;
    } finally {
        if (cacheClient.isOpen) {
            cacheClient.destroy();
        }
    }
};

main()
    .catch((error) => {
        console.error("RBAC seeding failed:", error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });