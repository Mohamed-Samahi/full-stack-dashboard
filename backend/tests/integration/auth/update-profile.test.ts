import jwt from "jsonwebtoken";

import {
    describe,
    expect,
    it,
} from "vitest";

import { prisma } from "../../../src/config/db.js";
import { redis } from "../../../src/config/redis.js";

import {
    verifyAccessToken,
} from "../../../src/utils/jwt.js";

import {
    hashRefreshToken,
} from "../../../src/utils/refreshToken.js";

import {
    ROLE_PERMISSIONS,
} from "../../../src/features/rbac/rbac.constants.js";

import {
    loginTestUser,
    withAuth,
} from "../../helpers/auth.helper.js";

import {
    createTestUser,
} from "../../factories/user.factory.js";

import {
    api,
} from "../../helpers/api.helper.js";

import {
    setupIntegrationTests,
} from "../../setup/integration.js";

const endpoint = "/api/v1/auth/me";
const refreshEndpoint = "/api/v1/auth/refresh";
const passwordEndpoint = "/api/v1/auth/change-password";

const originalTimestamp = new Date("2025-01-01T00:00:00.000Z");

const getUser = (id: string) =>
    prisma.user.findUniqueOrThrow({
        where: { id },
    });

const getProfile = (token: string) =>
    api
        .get(endpoint)
        .set(withAuth(token));

const updateProfile = (
    token: string,
    payload: Record<string, unknown>
) =>
    api
        .patch(endpoint)
        .set(withAuth(token))
        .send(payload);

const getRefreshCookie = (cookies: string | string[]) => {
    const values = Array.isArray(cookies)
        ? cookies
        : [cookies];

    const cookie = values.find((value) =>
        value.startsWith("refreshToken=")
    );

    if (!cookie) {
        throw new Error("Missing refresh token cookie");
    }

    return cookie.split(";")[0]!;
};

const createExpiredToken = (token: string) => {
    const payload = verifyAccessToken(token);

    return jwt.sign(
        {
            userId: payload.userId,
            roleId: payload.roleId,
            role: payload.role,
            permissions: payload.permissions,
            userVersion: payload.userVersion,
            roleVersion: payload.roleVersion,
        },
        process.env.JWT_ACCESS_SECRET!,
        { expiresIn: -1 }
    );
};

describe("PATCH /api/v1/auth/me", () => {
    setupIntegrationTests();

    // --------------------------------------------
    // Profile updates and response consistency
    // --------------------------------------------

    it.each([
        "ADMIN",
        "EMPLOYEE",
        "USER",
    ] as const)(
        "should allow %s to update their own profile",
        async (role) => {
            const { user, accessToken } = await loginTestUser({
                role,
                permissions: [...ROLE_PERMISSIONS[role]],
            });

            await prisma.user.update({
                where: { id: user.id },
                data: {
                    updatedAt: originalTimestamp,
                },
            });

            const before = await getUser(user.id);

            const previousProfile = await getProfile(
                accessToken
            ).expect(200);

            const response = await updateProfile(
                accessToken,
                {
                    name: "  Updated Profile Name  ",
                }
            ).expect(200);

            const after = await getUser(user.id);

            expect(after).toEqual({
                ...before,
                name: "Updated Profile Name",
                updatedAt: expect.any(Date),
            });

            expect(after.updatedAt.getTime())
                .toBeGreaterThan(before.updatedAt.getTime());

            expect(response.body).toEqual({
                data: {
                    id: user.id,
                    name: "Updated Profile Name",
                    email: user.email,
                    role,
                    permissions:
                        previousProfile.body.data.permissions,
                    createdAt: before.createdAt.toISOString(),
                    updatedAt: after.updatedAt.toISOString(),
                },
            });

            const currentProfile = await getProfile(
                accessToken
            ).expect(200);

            expect(response.body)
                .toEqual(currentProfile.body);

            expect(response.headers["set-cookie"])
                .toBeUndefined();
        }
    );

    it("should allow an account with a null name to set its name", async () => {
        const { user, accessToken } = await loginTestUser();

        await prisma.user.update({
            where: { id: user.id },
            data: {
                name: null,
                updatedAt: originalTimestamp,
            },
        });

        const response = await updateProfile(
            accessToken,
            { name: "New Account Name" }
        ).expect(200);

        const updated = await getUser(user.id);

        expect(updated.name).toBe("New Account Name");

        expect(response.body.data.name)
            .toBe(updated.name);

        expect(updated.updatedAt.getTime())
            .toBeGreaterThan(originalTimestamp.getTime());
    });

    it.each([
        "AB",
        "A".repeat(100),
    ])(
        "should persist valid name boundary values",
        async (name) => {
            const { user, accessToken } = await loginTestUser();

            const response = await updateProfile(
                accessToken,
                { name: `  ${name}  ` }
            ).expect(200);

            expect(response.body.data.name).toBe(name);

            expect((await getUser(user.id)).name)
                .toBe(name);
        }
    );

    // --------------------------------------------
    // Authentication and profile ownership
    // --------------------------------------------

    it("should require authentication before validation", async () => {
        const { user } = await createTestUser();

        const before = await getUser(user.id);

        await api
            .patch(endpoint)
            .send({ name: "Unauthorized Name" })
            .expect(401);

        await api
            .patch(endpoint)
            .send({})
            .expect(401);

        expect(await getUser(user.id))
            .toEqual(before);
    });

    it("should reject malformed and expired access tokens", async () => {
        const { user, accessToken } = await loginTestUser();

        const before = await getUser(user.id);

        for (const token of [
            "invalid.jwt.token",
            createExpiredToken(accessToken),
        ]) {
            await updateProfile(
                token,
                { name: "Unauthorized Name" }
            ).expect(401);
        }

        expect(await getUser(user.id))
            .toEqual(before);
    });

    it.each([
        "user",
        "role",
    ] as const)(
        "should reject revoked %s authentication versions",
        async (versionType) => {
            const { user, accessToken } = await loginTestUser();

            if (versionType === "user") {
                await prisma.user.update({
                    where: { id: user.id },
                    data: {
                        authVersion: { increment: 1 },
                    },
                });
            } else {
                await prisma.role.update({
                    where: { id: user.roleId },
                    data: {
                        authVersion: { increment: 1 },
                    },
                });
            }

            const before = await getUser(user.id);

            await updateProfile(
                accessToken,
                { name: "Unauthorized Name" }
            ).expect(401);

            expect(await getUser(user.id))
                .toEqual(before);
        }
    );

    it("should reject access tokens belonging to deleted users", async () => {
        const { user, accessToken } = await loginTestUser();

        await prisma.user.delete({
            where: { id: user.id },
        });

        await updateProfile(
            accessToken,
            { name: "Updated Name" }
        ).expect(401);

        expect(
            await prisma.user.findUnique({
                where: { id: user.id },
            })
        ).toBeNull();
    });

    it("should prevent users from updating another user's profile", async () => {
        const actor = await loginTestUser({
            role: "USER",
        });

        const target = await createTestUser({
            role: "USER",
            name: "Other User",
        });

        const actorBefore = await getUser(actor.user.id);
        const targetBefore = await getUser(target.user.id);

        for (const fields of [
            { id: target.user.id },
            { userId: target.user.id },
            { email: target.user.email },
        ]) {
            await updateProfile(
                actor.accessToken,
                {
                    name: "Unauthorized Name",
                    ...fields,
                }
            ).expect(400);
        }

        expect(await getUser(actor.user.id))
            .toEqual(actorBefore);

        expect(await getUser(target.user.id))
            .toEqual(targetBefore);

        const response = await updateProfile(
            actor.accessToken,
            { name: "Actor Updated Name" }
        ).expect(200);

        expect(response.body.data.id)
            .toBe(actor.user.id);

        expect(await getUser(target.user.id))
            .toEqual(targetBefore);
    });

    // --------------------------------------------
    // Validation and rejected mutations
    // --------------------------------------------

    it.each([
        {},
        { name: null },
        { name: "" },
        { name: "   " },
        { name: "A" },
        { name: "A".repeat(101) },
        { name: 123 },
        { name: true },
        { name: [] },
        { name: {} },
        { name: "John\u0000Doe" },
    ])(
        "should reject invalid names without modifying the account: %j",
        async (payload) => {
            const { user, accessToken } = await loginTestUser();

            const before = await getUser(user.id);

            await updateProfile(
                accessToken,
                payload
            ).expect(400);

            expect(await getUser(user.id))
                .toEqual(before);
        }
    );

    it.each([
        { email: "another@example.com" },
        { password: "NewPassword123!" },
        { role: "ADMIN" },
        { roleId: "invalid-role-id" },
        { permissions: ["user:update"] },
        { authVersion: 100 },
        { createdAt: "2025-01-01" },
        { updatedAt: "2025-01-01" },
        { unsupportedField: true },
    ])(
        "should reject unauthorized profile fields: %j",
        async (fields) => {
            const { user, accessToken } = await loginTestUser();

            const before = await getUser(user.id);

            await updateProfile(
                accessToken,
                {
                    name: "Updated Name",
                    ...fields,
                }
            ).expect(400);

            expect(await getUser(user.id))
                .toEqual(before);
        }
    );

    it("should reject null characters during registration", async () => {
        await createTestUser({ role: "USER" });

        const email = "null-character@example.com";

        const countBefore = await prisma.user.count();

        await api
            .post("/api/v1/auth/register")
            .send({
                name: "John\u0000Doe",
                email,
                password: "Password123!",
            })
            .expect(400);

        expect(await prisma.user.count())
            .toBe(countBefore);

        expect(
            await prisma.user.findUnique({
                where: { email },
            })
        ).toBeNull();
    });

    // --------------------------------------------
    // No-op updates and timestamps
    // --------------------------------------------

    it.each([
        "Test User",
        "  Test User  ",
    ])(
        "should preserve timestamps for unchanged normalized names",
        async (name) => {
            const { user, accessToken } = await loginTestUser({
                name: "Test User",
            });

            await prisma.user.update({
                where: { id: user.id },
                data: {
                    updatedAt: originalTimestamp,
                },
            });

            const before = await getUser(user.id);

            const previousProfile = await getProfile(
                accessToken
            ).expect(200);

            const response = await updateProfile(
                accessToken,
                { name }
            ).expect(200);

            expect(await getUser(user.id))
                .toEqual(before);

            expect(response.body)
                .toEqual(previousProfile.body);

            expect(response.headers["set-cookie"])
                .toBeUndefined();
        }
    );

    it("should preserve timestamps after repeating a successful update", async () => {
        const { user, accessToken } = await loginTestUser();

        const first = await updateProfile(
            accessToken,
            { name: "Updated Name" }
        ).expect(200);

        const before = await getUser(user.id);

        const second = await updateProfile(
            accessToken,
            { name: "  Updated Name  " }
        ).expect(200);

        expect(await getUser(user.id))
            .toEqual(before);

        expect(second.body)
            .toEqual(first.body);
    });

    // --------------------------------------------
    // Concurrent profile updates
    // --------------------------------------------

    it("should preserve timestamps during concurrent no-op updates", async () => {
        const { user, accessToken } = await loginTestUser({
            name: "Unchanged Name",
        });

        await prisma.user.update({
            where: { id: user.id },
            data: {
                updatedAt: originalTimestamp,
            },
        });

        const before = await getUser(user.id);

        const responses = await Promise.all(
            Array.from({ length: 5 }, () =>
                updateProfile(
                    accessToken,
                    { name: "  Unchanged Name  " }
                ).expect(200)
            )
        );

        for (const response of responses) {
            expect(response.body.data.updatedAt)
                .toBe(originalTimestamp.toISOString());
        }

        expect(await getUser(user.id))
            .toEqual(before);
    });

    it("should persist concurrent identical updates without repeated modifications", async () => {
        const { user, accessToken } = await loginTestUser();

        await prisma.user.update({
            where: { id: user.id },
            data: {
                updatedAt: originalTimestamp,
            },
        });

        const before = await getUser(user.id);

        const responses = await Promise.all(
            Array.from({ length: 5 }, () =>
                updateProfile(
                    accessToken,
                    { name: "Concurrent Name" }
                ).expect(200)
            )
        );

        const after = await getUser(user.id);

        expect(after).toEqual({
            ...before,
            name: "Concurrent Name",
            updatedAt: expect.any(Date),
        });

        expect(after.updatedAt.getTime())
            .toBeGreaterThan(before.updatedAt.getTime());

        for (const response of responses) {
            expect(response.body.data.name)
                .toBe("Concurrent Name");

            expect(response.body.data.updatedAt)
                .toBe(after.updatedAt.toISOString());
        }
    });

    it("should handle concurrent distinct updates without corrupting account data", async () => {
        const { user, accessToken } = await loginTestUser();

        const before = await getUser(user.id);

        const names = [
            "Concurrent Name One",
            "Concurrent Name Two",
            "Concurrent Name Three",
        ];

        const responses = await Promise.all(
            names.map((name) =>
                updateProfile(
                    accessToken,
                    { name }
                ).expect(200)
            )
        );

        const after = await getUser(user.id);

        expect(names).toContain(after.name);

        expect(after).toEqual({
            ...before,
            name: expect.any(String),
            updatedAt: expect.any(Date),
        });

        for (const response of responses) {
            expect(response.body.data.id)
                .toBe(user.id);

            expect(names)
                .toContain(response.body.data.name);
        }

        const profile = await getProfile(
            accessToken
        ).expect(200);

        expect(profile.body.data.name)
            .toBe(after.name);

        expect(profile.body.data.updatedAt)
            .toBe(after.updatedAt.toISOString());
    });

    // --------------------------------------------
    // Session and authentication preservation
    // --------------------------------------------

    it("should preserve existing access and refresh tokens after a profile update", async () => {
        const {
            user,
            accessToken,
            cookies,
        } = await loginTestUser({
            role: "EMPLOYEE",
            permissions: [...ROLE_PERMISSIONS.EMPLOYEE],
        });

        const refreshCookie = getRefreshCookie(cookies);

        const refreshToken = refreshCookie.slice(
            "refreshToken=".length
        );

        const redisKey =
            `refresh_token:${hashRefreshToken(refreshToken)}`;

        const before = await getUser(user.id);

        const roleBefore = await prisma.role.findUniqueOrThrow({
            where: { id: user.roleId },
        });

        const ttlBefore = await redis.ttl(redisKey);

        expect(await redis.get(redisKey))
            .toBe(user.id);

        expect(ttlBefore).toBeGreaterThan(0);

        const response = await updateProfile(
            accessToken,
            { name: "Session Preserved Name" }
        ).expect(200);

        const after = await getUser(user.id);

        expect(after).toEqual({
            ...before,
            name: "Session Preserved Name",
            updatedAt: expect.any(Date),
        });

        expect(
            await prisma.role.findUniqueOrThrow({
                where: { id: user.roleId },
            })
        ).toEqual(roleBefore);

        expect(response.headers["set-cookie"])
            .toBeUndefined();

        expect(await redis.get(redisKey))
            .toBe(user.id);

        const ttlAfter = await redis.ttl(redisKey);

        expect(ttlAfter).toBeGreaterThan(0);
        expect(ttlAfter).toBeLessThanOrEqual(ttlBefore);

        const profile = await getProfile(
            accessToken
        ).expect(200);

        expect(profile.body).toEqual(response.body);

        const refreshed = await api
            .post(refreshEndpoint)
            .set("Cookie", refreshCookie)
            .expect(200);

        const refreshedToken =
            refreshed.body.data.accessToken as string;

        const payload = verifyAccessToken(refreshedToken);

        expect(payload.userVersion)
            .toBe(before.authVersion);

        expect(payload.roleVersion)
            .toBe(roleBefore.authVersion);

        expect(payload.permissions)
            .toEqual(verifyAccessToken(accessToken).permissions);

        const refreshedProfile = await getProfile(
            refreshedToken
        ).expect(200);

        expect(refreshedProfile.body)
            .toEqual(response.body);
    });

    // --------------------------------------------
    // Existing password management compatibility
    // --------------------------------------------

    it("should preserve password management and session revocation after a profile update", async () => {
        const currentPassword = "TestPassword123!";
        const newPassword = "NewPassword456!";

        const {
            user,
            accessToken,
            cookies,
        } = await loginTestUser({
            password: currentPassword,
        });

        const refreshCookie = getRefreshCookie(cookies);

        const before = await getUser(user.id);

        await updateProfile(
            accessToken,
            { name: "Updated Account Name" }
        ).expect(200);

        await api
            .patch(passwordEndpoint)
            .set(withAuth(accessToken))
            .send({
                currentPassword,
                newPassword,
            })
            .expect(200);

        const after = await getUser(user.id);

        expect(after.name)
            .toBe("Updated Account Name");

        expect(after.authVersion)
            .toBe(before.authVersion + 1);

        expect(after.password)
            .not.toBe(before.password);

        await updateProfile(
            accessToken,
            { name: "Revoked Session Name" }
        ).expect(401);

        await api
            .post(refreshEndpoint)
            .set("Cookie", refreshCookie)
            .expect(401);

        const login = await api
            .post("/api/v1/auth/login")
            .send({
                email: user.email,
                password: newPassword,
            })
            .expect(200);

        const newAccessToken =
            login.body.data.accessToken as string;

        const profile = await getProfile(
            newAccessToken
        ).expect(200);

        expect(profile.body.data.name)
            .toBe("Updated Account Name");

        await updateProfile(
            newAccessToken,
            { name: "Authenticated Again" }
        ).expect(200);

        expect((await getUser(user.id)).name)
            .toBe("Authenticated Again");
    });
});