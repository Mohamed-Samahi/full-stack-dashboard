import { describe, expect, it } from "vitest";

import { prisma } from "../../../src/config/db.js";
import { redis } from "../../../src/config/redis.js";

import { api } from "../../helpers/api.helper.js";

import {
    loginTestUser,
    createTestAccessToken,
    withAuth,
} from "../../helpers/auth.helper.js";

import {
    createTestUser,
} from "../../factories/user.factory.js";

import {
    runRbacCli,
} from "../../helpers/rbac-cli.helper.js";

import {
    setupIntegrationTests,
} from "../../setup/integration.js";

const sharedPermissions = [
    "ticket:create",
    "ticket:read",
    "ticket:update",
    "ticket:transition",
    "ticket:comment",
    "ticket:attach",
];

const expectedPermissions = {
    ADMIN: [
        ...sharedPermissions,
        "ticket:assign",
        "user:read",
        "user:update",
        "role:read",
        "permission:read",
    ].sort(),

    EMPLOYEE: [
        ...sharedPermissions,
        "ticket:self-assign",
    ].sort(),

    USER: [...sharedPermissions].sort(),
};

const seed = async () => {
    const result = await runRbacCli("prisma/seed.ts");

    expect(result.exitCode, result.stderr).toBe(0);
};

const getRole = (name: string) =>
    prisma.role.findUniqueOrThrow({
        where: { name },
        include: {
            permissions: {
                include: {
                    permission: true,
                },
            },
        },
    });

const getPermissionKeys = async (name: string) => {
    const role = await getRole(name);

    return role.permissions
        .map(({ permission }) => permission.key)
        .sort();
};

const getRoleSnapshot = () =>
    prisma.role.findMany({
        select: {
            id: true,
            name: true,
            authVersion: true,
        },
        orderBy: { name: "asc" },
    });

describe("RBAC Permission Seeding", () => {
    setupIntegrationTests();

    it("should create the exact approved permission matrix", async () => {
        await seed();

        const roles = await prisma.role.findMany({
            orderBy: { name: "asc" },
        });

        expect(roles.map((role) => role.name)).toEqual([
            "ADMIN",
            "EMPLOYEE",
            "USER",
        ]);

        expect(await prisma.permission.count()).toBe(12);
        expect(await prisma.rolePermission.count()).toBe(24);

        for (const [role, permissions] of Object.entries(
            expectedPermissions
        )) {
            expect(await getPermissionKeys(role))
                .toEqual(permissions);
        }
    }, 60000);

    it("should be idempotent and preserve IDs and versions", async () => {
        await seed();

        const rolesBefore = await getRoleSnapshot();

        const permissionsBefore =
            await prisma.permission.findMany({
                select: {
                    id: true,
                    key: true,
                },
                orderBy: { key: "asc" },
            });

        await seed();

        expect(await getRoleSnapshot()).toEqual(rolesBefore);

        expect(await prisma.permission.findMany({
            select: {
                id: true,
                key: true,
            },
            orderBy: { key: "asc" },
        })).toEqual(permissionsBefore);

        expect(await prisma.rolePermission.count()).toBe(24);
    }, 90000);

    it("should reconcile obsolete and missing permissions and increment only affected versions", async () => {
        await seed();

        const adminBefore = await getRole("ADMIN");
        const employeeBefore = await getRole("EMPLOYEE");
        const userBefore = await getRole("USER");

        const obsoletePermission =
            await prisma.permission.create({
                data: { key: "legacy:read" },
            });

        const userRead =
            await prisma.permission.findUniqueOrThrow({
                where: { key: "user:read" },
            });

        const ticketRead =
            await prisma.permission.findUniqueOrThrow({
                where: { key: "ticket:read" },
            });

        await prisma.rolePermission.createMany({
            data: [
                {
                    roleId: employeeBefore.id,
                    permissionId: obsoletePermission.id,
                },
                {
                    roleId: employeeBefore.id,
                    permissionId: userRead.id,
                },
            ],
        });

        await prisma.rolePermission.delete({
            where: {
                roleId_permissionId: {
                    roleId: employeeBefore.id,
                    permissionId: ticketRead.id,
                },
            },
        });

        await seed();

        const adminAfter = await getRole("ADMIN");
        const employeeAfter = await getRole("EMPLOYEE");
        const userAfter = await getRole("USER");

        expect(employeeAfter.id).toBe(employeeBefore.id);

        expect(employeeAfter.authVersion)
            .toBe(employeeBefore.authVersion + 1);

        expect(adminAfter.authVersion)
            .toBe(adminBefore.authVersion);

        expect(userAfter.authVersion)
            .toBe(userBefore.authVersion);

        expect(await getPermissionKeys("EMPLOYEE"))
            .toEqual(expectedPermissions.EMPLOYEE);

        expect(
            await prisma.permission.findUnique({
                where: { id: obsoletePermission.id },
            })
        ).not.toBeNull();
    }, 90000);

    it("should revoke old role tokens and clear cached versions", async () => {
        const { user, accessToken } = await loginTestUser({
            role: "EMPLOYEE",
            permissions: ["user:read"],
        });

        const admin = await createTestUser({
            role: "ADMIN",
            permissions: expectedPermissions.ADMIN,
        });

        const unchangedToken = await createTestAccessToken(
            admin.user.id
        );

        const cacheKey =
            `auth:role:${user.roleId}:version`;

        await redis.set(
            cacheKey,
            String(user.role.authVersion)
        );

        await api
            .get("/api/v1/auth/me")
            .set(withAuth(accessToken))
            .expect(200);

        await seed();

        expect(await redis.get(cacheKey)).toBeNull();

        await api
            .get("/api/v1/auth/me")
            .set(withAuth(accessToken))
            .expect(401);

        // Restore a stale cache entry deliberately.
        await redis.set(
            cacheKey,
            String(user.role.authVersion)
        );

        await api
            .get("/api/v1/auth/me")
            .set(withAuth(accessToken))
            .expect(401);

        const freshToken = await createTestAccessToken(user.id);

        const response = await api
            .get("/api/v1/auth/me")
            .set(withAuth(freshToken))
            .expect(200);

        expect(
            [...response.body.data.permissions].sort()
        ).toEqual(expectedPermissions.EMPLOYEE);

        // An unaffected role's access token stays valid.
        await api
            .get("/api/v1/rbac/users")
            .set(withAuth(unchangedToken))
            .expect(200);
    }, 60000);

    it("should protect authorization when Redis invalidation fails and recover on reseeding", async () => {
        const { user, accessToken } = await loginTestUser({
            role: "EMPLOYEE",
            permissions: ["user:read"],
        });

        const cacheKey =
            `auth:role:${user.roleId}:version`;

        const staleVersion = String(user.role.authVersion);

        await redis.set(cacheKey, staleVersion);

        const failed = await runRbacCli("prisma/seed.ts", {
            redisFailure: true,
        });

        expect(failed.exitCode).toBe(1);

        expect(failed.stderr).toContain(
            "Database changes committed, but Redis invalidation failed."
        );

        // PostgreSQL committed the permission changes.
        expect(await getPermissionKeys("EMPLOYEE"))
            .toEqual(expectedPermissions.EMPLOYEE);

        const updatedRole = await getRole("EMPLOYEE");

        expect(updatedRole.authVersion)
            .toBe(user.role.authVersion + 1);

        // The stale Redis entry still exists.
        expect(await redis.get(cacheKey)).toBe(staleVersion);

        await api
            .get("/api/v1/auth/me")
            .set(withAuth(accessToken))
            .expect(401);

        // A successful rerun repairs the cache without
        // incrementing unchanged versions.
        await seed();

        expect(await redis.get(cacheKey)).toBeNull();

        expect((await getRole("EMPLOYEE")).authVersion)
            .toBe(updatedRole.authVersion);
    }, 90000);

    it("should not create demo accounts in production mode", async () => {
        const result = await runRbacCli("prisma/seed.ts", {
            production: true,
        });

        expect(result.exitCode, result.stderr).toBe(0);

        expect(await prisma.user.count()).toBe(0);
        expect(await prisma.role.count()).toBe(3);
        expect(await prisma.permission.count()).toBe(12);
    }, 60000);

    it("should preserve custom roles and existing user relationships", async () => {
        const { user: customUser } = await createTestUser({
            role: "CUSTOM",
            permissions: [
                "legacy:read",
                "user:read",
            ],
        });

        const { user: employee } = await createTestUser({
            role: "EMPLOYEE",
            permissions: ["user:read"],
        });

        const customRoleBefore = await getRole("CUSTOM");

        await seed();

        expect(await getRole("CUSTOM"))
            .toMatchObject({
                id: customRoleBefore.id,
                authVersion: customRoleBefore.authVersion,
            });

        expect(await getPermissionKeys("CUSTOM")).toEqual([
            "legacy:read",
            "user:read",
        ]);

        const storedCustomUser =
            await prisma.user.findUniqueOrThrow({
                where: { id: customUser.id },
            });

        const storedEmployee =
            await prisma.user.findUniqueOrThrow({
                where: { id: employee.id },
            });

        expect(storedCustomUser.roleId)
            .toBe(customUser.roleId);

        expect(storedEmployee.roleId)
            .toBe(employee.roleId);

        expect(await prisma.user.count()).toBe(2);

        const customToken = await createTestAccessToken(
            customUser.id
        );

        await api
            .get("/api/v1/rbac/users")
            .set(withAuth(customToken))
            .expect(403);
    }, 60000);
});