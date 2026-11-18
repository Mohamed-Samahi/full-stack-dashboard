import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { prisma } from "../../../src/config/db.js";
import { redis } from "../../../src/config/redis.js";

import logger from "../../../src/config/logger.js";

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
    setupIntegrationTests,
} from "../../setup/integration.js";

const endpoint = "/api/v1/rbac/users";

const createAdmin = () =>
    loginTestUser({
        role: "ADMIN",
        permissions: [
            "user:read",
            "user:update",
        ],
    });

const assignRole = (
    userId: string,
    roleId: string,
    accessToken: string
) =>
    api
        .patch(`${endpoint}/${userId}/role`)
        .set(withAuth(accessToken))
        .send({ roleId });

const getUser = (id: string) =>
    prisma.user.findUniqueOrThrow({
        where: { id },
        include: {
            role: true,
        },
    });

describe("RBAC Role Assignment", () => {
    setupIntegrationTests();

    it.each([
        ["USER", "ADMIN"],
        ["USER", "EMPLOYEE"],
        ["EMPLOYEE", "USER"],
    ])(
        "should allow ADMIN to change %s to %s",
        async (initialRole, targetRole) => {
            const admin = await createAdmin();

            const { user } = await createTestUser({
                role: initialRole,
            });

            const role = await prisma.role.upsert({
                where: { name: targetRole },
                update: {},
                create: { name: targetRole },
            });

            const response = await assignRole(
                user.id,
                role.id,
                admin.accessToken
            ).expect(200);

            expect(response.body.data).toEqual({
                id: user.id,
                name: user.name,
                email: user.email,
                role: {
                    id: role.id,
                    name: targetRole,
                },
            });

            const updated = await getUser(user.id);

            expect(updated.roleId).toBe(role.id);

            expect(updated.authVersion)
                .toBe(user.authVersion + 1);

            expect(response.body.data)
                .not.toHaveProperty("authVersion");

            expect(response.body.data)
                .not.toHaveProperty("password");
        }
    );

    it("should reject assignment to an existing custom role", async () => {
        const admin = await createAdmin();

        const { user } = await createTestUser();

        const customRole = await prisma.role.create({
            data: { name: "CUSTOM" },
        });

        await assignRole(
            user.id,
            customRole.id,
            admin.accessToken
        ).expect(400);

        const unchanged = await getUser(user.id);

        expect(unchanged.roleId).toBe(user.roleId);

        expect(unchanged.authVersion)
            .toBe(user.authVersion);
    });

    it("should reject unchanged role assignments", async () => {
        const admin = await createAdmin();

        const { user } = await createTestUser();

        const response = await assignRole(
            user.id,
            user.roleId,
            admin.accessToken
        ).expect(409);

        expect(response.body.message).toBe(
            "User already has this role"
        );

        expect((await getUser(user.id)).authVersion)
            .toBe(user.authVersion);
    });

    it.each([false, true])(
        "should prohibit ADMIN self-role changes when another ADMIN exists: %s",
        async (hasAnotherAdmin) => {
            const admin = await createAdmin();

            if (hasAnotherAdmin) {
                await createAdmin();
            }

            const userRole = await prisma.role.create({
                data: { name: "USER" },
            });

            const response = await assignRole(
                admin.user.id,
                userRole.id,
                admin.accessToken
            ).expect(403);

            expect(response.body.message).toBe(
                "Administrators cannot change their own role"
            );

            const unchanged = await getUser(admin.user.id);

            expect(unchanged.role.name).toBe("ADMIN");

            expect(unchanged.authVersion)
                .toBe(admin.user.authVersion);
        }
    );

    it("should allow demoting another ADMIN", async () => {
        const actor = await createAdmin();
        const target = await createAdmin();

        const userRole = await prisma.role.create({
            data: { name: "USER" },
        });

        await assignRole(
            target.user.id,
            userRole.id,
            actor.accessToken
        ).expect(200);

        expect((await getUser(target.user.id)).role.name)
            .toBe("USER");

        expect(await prisma.user.count({
            where: {
                role: { name: "ADMIN" },
            },
        })).toBe(1);
    });

    it("should prevent concurrent demotions from removing all administrators", async () => {
        const first = await createAdmin();
        const second = await createAdmin();

        const userRole = await prisma.role.create({
            data: { name: "USER" },
        });

        const responses = await Promise.all([
            assignRole(
                second.user.id,
                userRole.id,
                first.accessToken
            ),

            assignRole(
                first.user.id,
                userRole.id,
                second.accessToken
            ),
        ]);

        const successful = responses.filter(
            (response) => response.status === 200
        );

        const rejected = responses.filter(
            (response) => [401, 403].includes(response.status)
        );

        expect(successful).toHaveLength(1);
        expect(rejected).toHaveLength(1);

        expect(await prisma.user.count({
            where: {
                role: { name: "ADMIN" },
            },
        })).toBe(1);

        expect(await prisma.user.count({
            where: {
                role: { name: "USER" },
            },
        })).toBe(1);
    });

    it("should reject concurrent duplicate role assignments", async () => {
        const admin = await createAdmin();

        const { user } = await createTestUser({
            role: "USER",
        });

        const employeeRole = await prisma.role.create({
            data: { name: "EMPLOYEE" },
        });

        const responses = await Promise.all([
            assignRole(
                user.id,
                employeeRole.id,
                admin.accessToken
            ),

            assignRole(
                user.id,
                employeeRole.id,
                admin.accessToken
            ),
        ]);

        expect(
            responses.map(
                (response) => response.status
            ).sort()
        ).toEqual([200, 409]);

        const updated = await getUser(user.id);

        expect(updated.roleId).toBe(employeeRole.id);

        expect(updated.authVersion)
            .toBe(user.authVersion + 1);
    });

    it("should revoke old access tokens after role assignment", async () => {
        const admin = await createAdmin();

        const target = await loginTestUser({
            role: "EMPLOYEE",
            permissions: ["ticket:read"],
        });

        const userRole = await prisma.role.create({
            data: { name: "USER" },
        });

        const cacheKey =
            `auth:user:${target.user.id}:version`;

        await redis.set(
            cacheKey,
            String(target.user.authVersion)
        );

        await assignRole(
            target.user.id,
            userRole.id,
            admin.accessToken
        ).expect(200);

        expect(await redis.get(cacheKey)).toBeNull();

        await api
            .get("/api/v1/auth/me")
            .set(withAuth(target.accessToken))
            .expect(401);

        const freshToken = await createTestAccessToken(
            target.user.id
        );

        const response = await api
            .get("/api/v1/auth/me")
            .set(withAuth(freshToken))
            .expect(200);

        expect(response.body.data.role).toBe("USER");
    });

    it("should reject stale user versions even when the role is unchanged", async () => {
        const { user, accessToken } = await loginTestUser();

        const cacheKey = `auth:user:${user.id}:version`;

        await redis.set(
            cacheKey,
            String(user.authVersion)
        );

        await prisma.user.update({
            where: { id: user.id },
            data: {
                authVersion: {
                    increment: 1,
                },
            },
        });

        expect(await redis.get(cacheKey))
            .toBe(String(user.authVersion));

        await api
            .get("/api/v1/auth/me")
            .set(withAuth(accessToken))
            .expect(401);
    });

    it("should preserve revocation when user-version cache invalidation fails", async () => {
        const admin = await createAdmin();

        const target = await loginTestUser({
            role: "EMPLOYEE",
        });

        const userRole = await prisma.role.create({
            data: { name: "USER" },
        });

        const cacheKey =
            `auth:user:${target.user.id}:version`;

        await redis.set(
            cacheKey,
            String(target.user.authVersion)
        );

        const deleteSpy = vi.spyOn(redis, "del")
            .mockRejectedValueOnce(
                new Error("Simulated Redis failure")
            );

        const loggerSpy = vi.spyOn(logger, "error");

        try {
            await assignRole(
                target.user.id,
                userRole.id,
                admin.accessToken
            ).expect(200);

            expect(deleteSpy).toHaveBeenCalledWith(cacheKey);

            expect(loggerSpy).toHaveBeenCalledWith(
                expect.stringContaining("invalidation failed"),
                { userId: target.user.id }
            );
        } finally {
            deleteSpy.mockRestore();
            loggerSpy.mockRestore();
        }

        expect(await redis.get(cacheKey))
            .toBe(String(target.user.authVersion));

        const updated = await getUser(target.user.id);

        expect(updated.roleId).toBe(userRole.id);

        expect(updated.authVersion)
            .toBe(target.user.authVersion + 1);

        await api
            .get("/api/v1/auth/me")
            .set(withAuth(target.accessToken))
            .expect(401);
    });

    it("should reject invalid user and role identifiers", async () => {
        const admin = await createAdmin();

        const { user } = await createTestUser();

        await assignRole(
            "invalid-id",
            user.roleId,
            admin.accessToken
        ).expect(400);

        await assignRole(
            user.id,
            "invalid-id",
            admin.accessToken
        ).expect(400);

        await api
            .patch(`${endpoint}/${user.id}/role`)
            .set(withAuth(admin.accessToken))
            .send({})
            .expect(400);

        await api
            .patch(`${endpoint}/${user.id}/role`)
            .set(withAuth(admin.accessToken))
            .send({
                roleId: user.roleId,
                authVersion: 100,
            })
            .expect(400);

        expect((await getUser(user.id)).authVersion)
            .toBe(user.authVersion);
    });

    it("should return 404 for nonexistent users and roles", async () => {
        const admin = await createAdmin();

        const { user } = await createTestUser();

        const missingUser = await assignRole(
            randomUUID(),
            user.roleId,
            admin.accessToken
        ).expect(404);

        expect(missingUser.body.message).toBe(
            "User not found"
        );

        const missingRole = await assignRole(
            user.id,
            randomUUID(),
            admin.accessToken
        ).expect(404);

        expect(missingRole.body.message).toBe(
            "Role not found"
        );
    });
});