import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";

import { prisma } from "../../../src/config/db.js";

import { api } from "../../helpers/api.helper.js";

import {
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

const email = "provisioned-admin@example.com";
const password = "SecureTestAdmin123!";

const seed = async () => {
    const result = await runRbacCli("prisma/seed.ts");

    expect(result.exitCode, result.stderr).toBe(0);
};

const provision = (
    adminEmail = email,
    adminPassword = password
) =>
    runRbacCli("prisma/provision-admin.ts", {
        production: true,
        adminEmail,
        adminPassword,
    });

describe("Secure ADMIN Provisioning", () => {
    setupIntegrationTests();

    it("should securely provision an administrator using supplied credentials", async () => {
        await seed();

        const result = await provision(
            "  PROVISIONED-ADMIN@example.com  ",
            password
        );

        expect(result.exitCode, result.stderr).toBe(0);

        const user = await prisma.user.findUniqueOrThrow({
            where: { email },
            include: {
                role: true,
            },
        });

        expect(user.role.name).toBe("ADMIN");
        expect(user.name).toBe("Administrator");

        expect(user.password).not.toBeNull();
        expect(user.password).not.toBe(password);

        expect(await bcrypt.compare(
            password,
            user.password!
        )).toBe(true);

        expect(result.stdout).not.toContain(password);
        expect(result.stderr).not.toContain(password);

        const loginResponse = await api
            .post("/api/v1/auth/login")
            .send({ email, password })
            .expect(200);

        await api
            .get("/api/v1/rbac/users")
            .set(withAuth(
                loginResponse.body.data.accessToken
            ))
            .expect(200);
    }, 90000);

    it("should be idempotent without resetting credentials", async () => {
        await seed();

        const first = await provision();

        expect(first.exitCode, first.stderr).toBe(0);

        const before = await prisma.user.findUniqueOrThrow({
            where: { email },
        });

        const second = await provision();

        expect(second.exitCode, second.stderr).toBe(0);

        const after = await prisma.user.findUniqueOrThrow({
            where: { email },
        });

        expect(await prisma.user.count()).toBe(1);
        expect(after).toEqual(before);

        expect(second.stdout).toContain(
            "Administrator already provisioned"
        );
    }, 120000);

    it.each([
        ["missing email", "", password],
        ["invalid email", "invalid-email", password],
        ["missing password", email, ""],
        ["short password", email, "short"],
        ["oversized password", email, "a".repeat(73)],
        ["multibyte overflow", email, "é".repeat(37)],
    ])(
        "should reject %s without creating an administrator",
        async (_scenario, adminEmail, adminPassword) => {
            await prisma.role.create({
                data: { name: "ADMIN" },
            });

            const result = await provision(
                adminEmail,
                adminPassword
            );

            expect(result.exitCode).toBe(1);

            expect(result.stderr).toContain(
                "Provide a valid ADMIN_EMAIL"
            );

            expect(await prisma.user.count()).toBe(0);
        },
        60000
    );

    it("should reject provisioning before the ADMIN role exists", async () => {
        const result = await provision();

        expect(result.exitCode).toBe(1);

        expect(result.stderr).toContain(
            "ADMIN role is not configured"
        );

        expect(await prisma.user.count()).toBe(0);
    }, 60000);

    it("should not promote an existing non-admin account", async () => {
        await seed();

        const { user } = await createTestUser({
            email,
            password,
            role: "USER",
        });

        const result = await provision();

        expect(result.exitCode).toBe(1);

        expect(result.stderr).toContain(
            "is not an administrator"
        );

        const unchanged = await prisma.user.findUniqueOrThrow({
            where: { id: user.id },
            include: {
                role: true,
            },
        });

        expect(unchanged.role.name).toBe("USER");

        expect(unchanged.authVersion)
            .toBe(user.authVersion);

        expect(unchanged.password).toBe(user.password);

        expect(await prisma.user.count()).toBe(1);
    }, 90000);

    it("should not reset an existing administrator password", async () => {
        await seed();

        const { user } = await createTestUser({
            email,
            password,
            role: "ADMIN",
        });

        const result = await provision(
            email,
            "DifferentAdminPassword123!"
        );

        expect(result.exitCode).toBe(1);

        expect(result.stderr).toContain(
            "Existing administrator credentials do not match"
        );

        const unchanged = await prisma.user.findUniqueOrThrow({
            where: { id: user.id },
        });

        expect(unchanged.password).toBe(user.password);

        expect(unchanged.authVersion)
            .toBe(user.authVersion);

        expect(await prisma.user.count()).toBe(1);
    }, 90000);

    it("should reject password provisioning for an existing OAuth-only administrator", async () => {
        const role = await prisma.role.create({
            data: { name: "ADMIN" },
        });

        const user = await prisma.user.create({
            data: {
                email,
                password: null,
                roleId: role.id,
            },
        });

        const result = await provision();

        expect(result.exitCode).toBe(1);

        const unchanged = await prisma.user.findUniqueOrThrow({
            where: { id: user.id },
        });

        expect(unchanged.password).toBeNull();

        expect(unchanged.authVersion)
            .toBe(user.authVersion);
    }, 60000);

    it("should safely handle concurrent provisioning requests", async () => {
        await seed();

        const results = await Promise.all([
            provision(),
            provision(),
        ]);

        for (const result of results) {
            expect(result.exitCode, result.stderr).toBe(0);
        }

        expect(await prisma.user.count({
            where: { email },
        })).toBe(1);

        const user = await prisma.user.findUniqueOrThrow({
            where: { email },
            include: {
                role: true,
            },
        });

        expect(user.role.name).toBe("ADMIN");

        expect(await bcrypt.compare(
            password,
            user.password!
        )).toBe(true);
    }, 90000);
});