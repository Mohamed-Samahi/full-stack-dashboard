import { describe, expect, it } from "vitest";

import {
    registerSchema,
    loginSchema,
    changePasswordSchema,
} from "../../../../src/features/auth/auth.schema.js";

describe("Authentication Schemas", () => {
    describe("registerSchema", () => {
        const validUser = {
            name: "Test User",
            email: "test@example.com",
            password: "Password123!",
        };

        it("should accept valid registration data", () => {
            expect(registerSchema.safeParse(validUser).success).toBe(true);
        });

        it("should allow registration without an optional name", () => {
            const { name, ...data } = validUser;

            expect(registerSchema.safeParse(data).success).toBe(true);
        });

        it.each([
            ["invalid email", { ...validUser, email: "invalid" }],
            ["short password", { ...validUser, password: "123" }],
            ["short name", { ...validUser, name: "A" }],
            ["missing email", { name: "Test", password: "Password123!" }],
            ["missing password", { name: "Test", email: "test@example.com" }],
        ])("should reject %s", (_scenario, data) => {
            expect(registerSchema.safeParse(data).success).toBe(false);
        });
    });

    describe("loginSchema", () => {
        it("should accept valid credentials", () => {
            expect(loginSchema.safeParse({
                email: "test@example.com",
                password: "Password123!",
            }).success).toBe(true);
        });

        it.each([
            ["invalid email", { email: "invalid", password: "Password123!" }],
            ["empty password", { email: "test@example.com", password: "" }],
            ["missing email", { password: "Password123!" }],
            ["missing password", { email: "test@example.com" }],
        ])("should reject %s", (_scenario, data) => {
            expect(loginSchema.safeParse(data).success).toBe(false);
        });
    });

    describe("Authentication Schema Consistency", () => {
        const validUser = {
            name: "Test User",
            email: "test@example.com",
            password: "Password123!",
        };

        it("should normalize registration email and name", () => {
            const result = registerSchema.parse({
                ...validUser,
                email: "  TEST@Example.COM  ",
                name: "  Test User  ",
            });

            expect(result.email).toBe("test@example.com");
            expect(result.name).toBe("Test User");
        });

        it("should normalize login email", () => {
            const result = loginSchema.parse({
                email: "  TEST@Example.COM  ",
                password: validUser.password,
            });

            expect(result.email).toBe("test@example.com");
        });

        it.each([
            { role: "ADMIN" },
            { roleId: "admin-role-id" },
            { permissions: ["user:update"] },
            { authVersion: 10 },
            { unsupportedField: true },
        ])("should reject unsupported registration fields: %j", (fields) => {
            expect(
                registerSchema.safeParse({
                    ...validUser,
                    ...fields,
                }).success
            ).toBe(false);
        });

        it.each([
            ["  ", false],
            [" A ", false],
            ["AB", true],
            ["A".repeat(100), true],
            ["A".repeat(101), false],
        ])("should validate registration name length", (name, valid) => {
            expect(
                registerSchema.safeParse({
                    ...validUser,
                    name,
                }).success
            ).toBe(valid);
        });

        it.each([
            ["a".repeat(72), true],
            ["a".repeat(73), false],
            ["é".repeat(36), true],
            ["é".repeat(36) + "a", false],
            ["😀".repeat(18), true],
            ["😀".repeat(19), false],
        ])("should enforce the UTF-8 password byte limit", (password, valid) => {
            expect(
                registerSchema.safeParse({
                    ...validUser,
                    password,
                }).success
            ).toBe(valid);

            expect(
                changePasswordSchema.safeParse({
                    currentPassword: validUser.password,
                    newPassword: password,
                }).success
            ).toBe(valid);
        });
    });
});
