import { prisma } from "../../config/db.js";
import { AppError } from "../../errors/AppError.js";

import { redis } from "../../config/redis.js";
import logger from "../../config/logger.js";

import {
    PREDEFINED_ROLES,
    PERMISSIONS,
    PERMISSION_DEFINITIONS,
    isPredefinedRole,
} from "./rbac.constants.js";

import {
    lockRbacConfiguration,
} from "./rbac.lock.js";

import {
    deleteRoleVersion,
    setRoleVersion,
    deleteUserVersion,
} from "../../utils/authVersion.js";

const getPermissions = async () => {
    return prisma.permission.findMany({
        where: {
            key: {
                in: Object.keys(PERMISSION_DEFINITIONS),
            },
        },
        select: {
            id: true,
            key: true,
            description: true,
        },
        orderBy: {
            key: "asc",
        },
    });
};

const getRoles = async () => {
    const roles = await prisma.role.findMany({
        where: {
            name: {
                in: [...PREDEFINED_ROLES],
            },
        },
        select: {
            id: true,
            name: true,
            permissions: {
                where: {
                    permission: {
                        key: {
                            in: Object.keys(
                                PERMISSION_DEFINITIONS
                            ),
                        },
                    },
                },
                select: {
                    permission: {
                        select: {
                            key: true,
                            description: true,
                        },
                    },
                },
                orderBy: {
                    permission: {
                        key: "asc",
                    },
                },
            },
        },
        orderBy: {
            name: "asc",
        },
    });

    return roles.map((role) => ({
        id: role.id,
        name: role.name,
        permissions: role.permissions.map(
            (rolePermission) => rolePermission.permission
        ),
    }));
};

type CreateRoleData = {
    name: string;
    permissions: string[];
};

const createRole = async (data: CreateRoleData) => {
    const existingRole = await prisma.role.findUnique({
        where: {
            name: data.name,
        },
    });

    if (existingRole) {
        throw new AppError("Role already exists", 409);
    }

    const permissions = await prisma.permission.findMany({
        where: {
            key: {
                in: data.permissions,
            },
        },
        select: {
            id: true,
            key: true,
        },
    });

    if (permissions.length !== data.permissions.length) {
        throw new AppError(
            "One or more permissions do not exist",
            400
        );
    }

    return prisma.role.create({
        data: {
            name: data.name,
            permissions: {
                create: permissions.map((permission) => ({
                    permissionId: permission.id,
                })),
            },
        },
        select: {
            id: true,
            name: true,
            permissions: {
                select: {
                    permission: {
                        select: {
                            key: true,
                            description: true,
                        },
                    },
                },
            },
        },
    });
};

type UpdateRoleData = {
    name?: string;
    permissions?: string[];
};

const updateRole = async (
    roleId: string,
    data: UpdateRoleData
) => {
    const role = await prisma.role.findUnique({
        where: {
            id: roleId,
        },
    });

    if (!role) {
        throw new AppError("Role not found", 404);
    }

    if (data.name && data.name !== role.name) {
        const existingRole = await prisma.role.findUnique({
            where: {
                name: data.name,
            },
        });

        if (existingRole) {
            throw new AppError("Role already exists", 409);
        }
    }

    let permissions:
        | { id: string; key: string }[]
        | undefined;

    if (data.permissions !== undefined) {
        permissions = await prisma.permission.findMany({
            where: {
                key: {
                    in: data.permissions,
                },
            },
            select: {
                id: true,
                key: true,
            },
        });

        if (permissions.length !== data.permissions.length) {
            throw new AppError(
                "One or more permissions do not exist",
                400
            );
        }
    }

    const updatedRole = await prisma.$transaction(async (tx) => {
        if (permissions !== undefined) {
            await tx.rolePermission.deleteMany({
                where: {
                    roleId,
                },
            });

            if (permissions.length > 0) {
                await tx.rolePermission.createMany({
                    data: permissions.map((permission) => ({
                        roleId,
                        permissionId: permission.id,
                    })),
                });
            }
        }

        return tx.role.update({
            where: {
                id: roleId,
            },
            data: {
                ...(data.name !== undefined && {
                    name: data.name,
                }),
                authVersion: {
                    increment: 1,
                },
            },
            select: {
                id: true,
                name: true,
                authVersion: true,
                permissions: {
                    select: {
                        permission: {
                            select: {
                                key: true,
                                description: true,
                            },
                        },
                    },
                },
            },
        });
    });

    await setRoleVersion(
        updatedRole.id,
        updatedRole.authVersion
    );

    return updatedRole;
};

const deleteRole = async (roleId: string) => {
    const defaultRoleName = process.env.DEFAULT_USER_ROLE;

    if (!defaultRoleName) {
        throw new Error("DEFAULT_USER_ROLE is not defined");
    }

    const [role, defaultRole] = await Promise.all([
        prisma.role.findUnique({
            where: { id: roleId },
        }),
        prisma.role.findUnique({
            where: { name: defaultRoleName },
        }),
    ]);

    if (!role) {
        throw new AppError("Role not found", 404);
    }

    if (!defaultRole) {
        throw new AppError(
            `Default role '${defaultRoleName}' is not configured`,
            500
        );
    }

    if (role.id === defaultRole.id) {
        throw new AppError(
            "The default role cannot be deleted",
            409
        );
    }

    await prisma.$transaction(async (tx) => {
        // Move all affected users to the default role
        await tx.user.updateMany({
            where: {
                roleId: role.id,
            },
            data: {
                roleId: defaultRole.id,
            },
        });

        // RolePermission records are removed automatically by cascade
        await tx.role.delete({
            where: {
                id: role.id,
            },
        });
    });

    await deleteRoleVersion(role.id);
};

const assignUserRole = async (
    userId: string,
    roleId: string,
    actorId: string
) => {
    const updatedUser = await prisma.$transaction(async (tx) => {
        await lockRbacConfiguration(tx);

        // Recheck administrative authorization after acquiring
        // the lock to protect against concurrent role changes.
        const actor = await tx.user.findUnique({
            where: {
                id: actorId,
            },
            select: {
                role: {
                    select: {
                        name: true,
                        permissions: {
                            where: {
                                permission: {
                                    key: PERMISSIONS.USER_UPDATE,
                                },
                            },
                            select: {
                                permissionId: true,
                            },
                        },
                    },
                },
            },
        });

        if (
            !actor ||
            actor.role.name !== "ADMIN" ||
            actor.role.permissions.length === 0
        ) {
            throw new AppError("Forbidden", 403);
        }

        // ADMIN cannot modify their own role.
        if (userId === actorId) {
            throw new AppError(
                "Administrators cannot change their own role",
                403
            );
        }

        const [user, role] = await Promise.all([
            tx.user.findUnique({
                where: {
                    id: userId,
                },
                select: {
                    id: true,
                    roleId: true,
                    role: {
                        select: {
                            name: true,
                        },
                    },
                },
            }),

            tx.role.findUnique({
                where: {
                    id: roleId,
                },
                select: {
                    id: true,
                    name: true,
                },
            }),
        ]);

        if (!user) {
            throw new AppError("User not found", 404);
        }

        if (!role) {
            throw new AppError("Role not found", 404);
        }

        if (!isPredefinedRole(role.name)) {
            throw new AppError("Unsupported target role", 400);
        }

        if (user.roleId === roleId) {
            throw new AppError(
                "User already has this role",
                409
            );
        }

        // The check and mutation execute under the same
        // transaction lock.
        if (
            user.role.name === "ADMIN" &&
            role.name !== "ADMIN"
        ) {
            const adminCount = await tx.user.count({
                where: {
                    roleId: user.roleId,
                },
            });

            if (adminCount <= 1) {
                throw new AppError(
                    "The final administrator cannot be demoted",
                    409
                );
            }
        }

        // Role change and token invalidation are atomic.
        return tx.user.update({
            where: {
                id: userId,
            },
            data: {
                roleId,
                authVersion: {
                    increment: 1,
                },
            },
            select: {
                id: true,
                name: true,
                email: true,
                role: {
                    select: {
                        id: true,
                        name: true,
                    },
                },
            },
        });
    }, {
        maxWait: 10000,
        timeout: 15000,
    });

    // Redis invalidation is performed only after commit.
    try {
        if (!redis.isReady) {
            throw new Error("Redis is not ready");
        }

        await deleteUserVersion(updatedUser.id);
    } catch {
        logger.error(
            "Role assignment committed, but user-version cache "
            + "invalidation failed",
            {
                userId: updatedUser.id,
            }
        );
    }

    return updatedUser;
};

const getUsers = async () => {
    return prisma.user.findMany({
        select: {
            id: true,
            name: true,
            email: true,
            role: {
                select: {
                    id: true,
                    name: true,
                },
            },
            createdAt: true,
        },
        orderBy: {
            createdAt: "desc",
        },
    });
};

export {
    getPermissions,
    getRoles,
    createRole,
    updateRole,
    deleteRole,
    assignUserRole,
    getUsers,
};