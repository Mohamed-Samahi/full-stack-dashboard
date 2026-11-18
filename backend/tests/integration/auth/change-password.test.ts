import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";

import { prisma } from "../../../src/config/db.js";
import { api } from "../../helpers/api.helper.js";

import {
    loginTestUser,
    createTestAccessToken,
    withAuth,
} from "../../helpers/auth.helper.js";

import {
    createOAuthTestUser,
} from "../../factories/oauth.factory.js";

import {
    setupIntegrationTests,
} from "../../setup/integration.js";

const endpoint = "/api/v1/auth/change-password";

const currentPassword = "TestPassword123!";
const newPassword = "NewPassword456!";

describe("PATCH /api/v1/auth/change-password", () => {
    setupIntegrationTests();

    it("should change the authenticated user's password", async () => {
        const { user, accessToken } = await loginTestUser({
            password: currentPassword,
        });

        const response = await api
            .patch(endpoint)
            .set(withAuth(accessToken))
            .send({
                currentPassword,
                newPassword,
            })
            .expect(200);

        expect(response.body.message).toBe(
            "Password changed successfully. Please log in again."
        );

        const updatedUser = await prisma.user.findUniqueOrThrow({
            where: { id: user.id },
        });

        expect(updatedUser.password).not.toBe(user.password);
        expect(updatedUser.password).not.toBe(newPassword);

        expect(
            await bcrypt.compare(
                newPassword,
                updatedUser.password!
            )
        ).toBe(true);

        expect(updatedUser.authVersion)
            .toBe(user.authVersion + 1);

        expect(updatedUser.roleId).toBe(user.roleId);
        expect(updatedUser.email).toBe(user.email);
    });

    it("should reject an incorrect current password", async () => {
        const { user, accessToken } = await loginTestUser({
            password: currentPassword,
        });

        const response = await api
            .patch(endpoint)
            .set(withAuth(accessToken))
            .send({
                currentPassword: "IncorrectPassword!",
                newPassword,
            })
            .expect(400);

        expect(response.body.message)
            .toBe("Current password is incorrect");

        const unchangedUser = await prisma.user.findUniqueOrThrow({
            where: { id: user.id },
        });

        expect(unchangedUser.password).toBe(user.password);
        expect(unchangedUser.authVersion).toBe(user.authVersion);
    });

    it("should reject reusing the existing password", async () => {
        const { user, accessToken } = await loginTestUser({
            password: currentPassword,
        });

        await api
            .patch(endpoint)
            .set(withAuth(accessToken))
            .send({
                currentPassword,
                newPassword: currentPassword,
            })
            .expect(400);

        const unchangedUser = await prisma.user.findUniqueOrThrow({
            where: { id: user.id },
        });

        expect(unchangedUser.password).toBe(user.password);
        expect(unchangedUser.authVersion).toBe(user.authVersion);
    });

    it("should reject password changes for Google-only accounts", async () => {
        const user = await createOAuthTestUser();

        const accessToken = await createTestAccessToken(user.id);

        const response = await api
            .patch(endpoint)
            .set(withAuth(accessToken))
            .send({
                currentPassword,
                newPassword,
            })
            .expect(400);

        expect(response.body.message).toBe(
            "This account does not have a password"
        );

        const unchangedUser = await prisma.user.findUniqueOrThrow({
            where: { id: user.id },
        });

        expect(unchangedUser.password).toBeNull();
        expect(unchangedUser.authVersion).toBe(user.authVersion);
    });

    it("should require authentication", async () => {
        await api
            .patch(endpoint)
            .send({
                currentPassword,
                newPassword,
            })
            .expect(401);
    });

    it.each([
        { currentPassword, newPassword: "short" },
        { currentPassword, newPassword: "" },
        { currentPassword, newPassword: "a".repeat(73) },
        { currentPassword, newPassword: "é".repeat(37) },
        { currentPassword, newPassword: 12345678 },
        { currentPassword },
        { newPassword },
        { currentPassword, newPassword, role: "ADMIN" },
    ])("should reject invalid password payloads: %j", async (data) => {
        const { user, accessToken } = await loginTestUser({
            password: currentPassword,
        });

        await api
            .patch(endpoint)
            .set(withAuth(accessToken))
            .send(data)
            .expect(400);

        const unchangedUser = await prisma.user.findUniqueOrThrow({
            where: { id: user.id },
        });

        expect(unchangedUser.password).toBe(user.password);
        expect(unchangedUser.authVersion).toBe(user.authVersion);
    });

    it("should prevent concurrent password changes", async () => {
        const { user, accessToken } = await loginTestUser({
            password: currentPassword,
        });

        const passwords = [
            "ConcurrentPassword123!",
            "ConcurrentPassword456!",
        ];

        const responses = await Promise.all(
            passwords.map((password) =>
                api
                    .patch(endpoint)
                    .set(withAuth(accessToken))
                    .send({
                        currentPassword,
                        newPassword: password,
                    })
            )
        );

        const successful = responses.filter(
            ({ status }) => status === 200
        );

        const rejected = responses.filter(
            ({ status }) => status !== 200
        );

        expect(successful).toHaveLength(1);
        expect(rejected).toHaveLength(1);

        expect([400, 401, 409]).toContain(
            rejected[0]!.status
        );

        const winningIndex = responses.findIndex(
            ({ status }) => status === 200
        );

        const updatedUser = await prisma.user.findUniqueOrThrow({
            where: { id: user.id },
        });

        expect(updatedUser.authVersion)
            .toBe(user.authVersion + 1);

        expect(
            await bcrypt.compare(
                passwords[winningIndex]!,
                updatedUser.password!
            )
        ).toBe(true);
    });

    it("should revoke previous sessions and clear the refresh cookie", async () => {
        const { user, accessToken, cookies } = await loginTestUser({
            password: currentPassword,
        });

        // Create an additional session for the same user.
        const secondSession = await api
            .post("/api/v1/auth/login")
            .send({
                email: user.email,
                password: currentPassword,
            })
            .expect(200);

        const response = await api
            .patch(endpoint)
            .set(withAuth(accessToken))
            .set("Cookie", cookies)
            .send({
                currentPassword,
                newPassword,
            })
            .expect(200);

        const clearedCookies = response.headers["set-cookie"];

        const refreshCookie = (
            Array.isArray(clearedCookies)
                ? clearedCookies
                : [clearedCookies]
        ).find((cookie: string) =>
            cookie.startsWith("refreshToken=")
        );

        expect(refreshCookie).toBeDefined();
        expect(refreshCookie).toMatch(/^refreshToken=;/);
        expect(refreshCookie).toMatch(
            /Expires=Thu, 01 Jan 1970/i
        );
        expect(refreshCookie).toContain("HttpOnly");

        // Access tokens issued before the change are invalid.
        await api
            .get("/api/v1/auth/me")
            .set(withAuth(accessToken))
            .expect(401);

        await api
            .get("/api/v1/auth/me")
            .set(withAuth(secondSession.body.data.accessToken))
            .expect(401);

        // Refresh tokens from both sessions are invalid.
        await api
            .post("/api/v1/auth/refresh")
            .set("Cookie", cookies)
            .expect(401);

        await api
            .post("/api/v1/auth/refresh")
            .set("Cookie", secondSession.headers["set-cookie"])
            .expect(401);
    });

    it("should authenticate only with the new password after a change", async () => {
        const { user, accessToken } = await loginTestUser({
            password: currentPassword,
        });

        await api
            .patch(endpoint)
            .set(withAuth(accessToken))
            .send({
                currentPassword,
                newPassword,
            })
            .expect(200);

        await api
            .post("/api/v1/auth/login")
            .send({
                email: user.email,
                password: currentPassword,
            })
            .expect(401);

        const response = await api
            .post("/api/v1/auth/login")
            .send({
                email: user.email,
                password: newPassword,
            })
            .expect(200);

        await api
            .get("/api/v1/auth/me")
            .set(withAuth(response.body.data.accessToken))
            .expect(200);
    });
});