import { createHash, randomBytes } from "node:crypto";

import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
    vi,
} from "vitest";

import { prisma } from "../../../src/config/db.js";
import { redis } from "../../../src/config/redis.js";

import { createTestUser } from "../../factories/user.factory.js";

import {
    setupIntegrationTests,
} from "../../setup/integration.js";

describe("Disabled Password Recovery Endpoints", () => {
    setupIntegrationTests();

    let api: typeof import("../../helpers/api.helper.js").api;

    beforeAll(async () => {
        vi.stubEnv("RESEND_API_KEY", undefined);
        vi.stubEnv("EMAIL_FROM", undefined);
        vi.stubEnv("FRONTEND_URL", undefined);

        // Initialize the Express application after removing
        // the email-service configuration.
        ({ api } = await import("../../helpers/api.helper.js"));
    });

    afterAll(() => {
        vi.unstubAllEnvs();
    });

    it("should disable forgot-password without creating side effects", async () => {
        const { user } = await createTestUser();

        const emailRequest = vi
            .spyOn(globalThis, "fetch")
            .mockRejectedValue(
                new Error("Unexpected external request")
            );

        const response = await api
            .post("/api/v1/auth/forgot-password")
            .send({
                email: user.email,
            })
            .expect(404);

        expect(response.body).toEqual({
            status: "error",
            message: "Not found",
        });

        expect(await prisma.passwordResetToken.count())
            .toBe(0);

        expect(await redis.dbSize()).toBe(0);
        expect(emailRequest).not.toHaveBeenCalled();

        const unchangedUser = await prisma.user.findUniqueOrThrow({
            where: { id: user.id },
        });

        expect(unchangedUser.password).toBe(user.password);
        expect(unchangedUser.authVersion).toBe(user.authVersion);
    });

    it("should disable reset-password even with a valid reset token", async () => {
        const { user } = await createTestUser();

        const token = randomBytes(32).toString("hex");

        const tokenHash = createHash("sha256")
            .update(token)
            .digest("hex");

        await prisma.passwordResetToken.create({
            data: {
                tokenHash,
                userId: user.id,
                expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            },
        });

        const emailRequest = vi
            .spyOn(globalThis, "fetch")
            .mockRejectedValue(
                new Error("Unexpected external request")
            );

        const response = await api
            .post("/api/v1/auth/reset-password")
            .send({
                token,
                newPassword: "NewPassword123!",
            })
            .expect(404);

        expect(response.body).toEqual({
            status: "error",
            message: "Not found",
        });

        const unchangedToken =
            await prisma.passwordResetToken.findUniqueOrThrow({
                where: { tokenHash },
            });

        expect(unchangedToken.usedAt).toBeNull();
        expect(await prisma.passwordResetToken.count()).toBe(1);

        const unchangedUser = await prisma.user.findUniqueOrThrow({
            where: { id: user.id },
        });

        expect(unchangedUser.password).toBe(user.password);
        expect(unchangedUser.authVersion).toBe(user.authVersion);

        expect(await redis.dbSize()).toBe(0);
        expect(emailRequest).not.toHaveBeenCalled();
    });

    it("should operate without email-service configuration", async () => {
        expect(process.env.RESEND_API_KEY).toBeUndefined();
        expect(process.env.EMAIL_FROM).toBeUndefined();
        expect(process.env.FRONTEND_URL).toBeUndefined();

        await prisma.role.create({
            data: { name: "USER" },
        });

        const credentials = {
            email: "no-email-service@example.com",
            password: "Password123!",
        };

        await api
            .post("/api/v1/auth/register")
            .send(credentials)
            .expect(201);

        const loginResponse = await api
            .post("/api/v1/auth/login")
            .send(credentials)
            .expect(200);

        await api
            .get("/api/v1/auth/me")
            .set(
                "Authorization",
                `Bearer ${loginResponse.body.data.accessToken}`
            )
            .expect(200);

        await api
            .post("/api/v1/auth/refresh")
            .set("Cookie", loginResponse.headers["set-cookie"])
            .expect(200);
    });
});