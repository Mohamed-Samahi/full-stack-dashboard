import bcrypt from "bcryptjs";
import {
    beforeEach,
    afterEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";

import { prisma } from "../../../src/config/db.js";
import { api } from "../../helpers/api.helper.js";
import { setupIntegrationTests } from "../../setup/integration.js";

const endpoint = "/api/v1/auth/register";

const validUser = () => ({
    name: "Test User",
    email: "test@example.com",
    password: "Password123!",
});

describe("POST /api/v1/auth/register", () => {
    setupIntegrationTests();

    beforeEach(async () => {
        await prisma.role.create({
            data: {
                name: "USER",
            },
        });
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("should register a new user successfully", async () => {
        const user = validUser();

        const response = await api
            .post(endpoint)
            .send(user)
            .expect(201);

        expect(response.body.data).toMatchObject({
            id: expect.any(String),
            name: user.name,
            email: user.email,
            role: {
                name: "USER",
            },
        });

        expect(response.body.data).not.toHaveProperty("password");

        const savedUser = await prisma.user.findUnique({
            where: { email: user.email },
        });

        expect(savedUser).not.toBeNull();
        expect(savedUser?.id).toBe(response.body.data.id);
    });

    it("should reject duplicate emails", async () => {
        const user = validUser();

        await api.post(endpoint).send(user).expect(201);

        const response = await api
            .post(endpoint)
            .send(user)
            .expect(409);

        expect(response.body.message).toBe("User already exists");

        expect(
            await prisma.user.count({
                where: { email: user.email },
            })
        ).toBe(1);
    });

    it.each([
        ["invalid email", { ...validUser(), email: "invalid" }],
        ["short password", { ...validUser(), password: "123" }],
        ["short name", { ...validUser(), name: "A" }],
        [
            "missing email",
            { name: "Test User", password: "Password123!" },
        ],
        [
            "missing password",
            { name: "Test User", email: "test@example.com" },
        ],
    ])("should reject %s", async (_scenario, data) => {
        const response = await api
            .post(endpoint)
            .send(data)
            .expect(400);

        expect(response.body.message).toBe("Validation failed");
        expect(response.body.errors.length).toBeGreaterThan(0);

        expect(await prisma.user.count()).toBe(0);
    });

    it("should hash passwords before saving them", async () => {
        const user = validUser();

        await api.post(endpoint).send(user).expect(201);

        const savedUser = await prisma.user.findUniqueOrThrow({
            where: { email: user.email },
        });

        expect(savedUser.password).not.toBeNull();

        if (savedUser.password === null) {
            throw new Error("Registered user must have a password");
        }

        expect(savedUser.password).not.toBe(user.password);

        expect(
            await bcrypt.compare(user.password, savedUser.password)
        ).toBe(true);

        expect(
            await bcrypt.compare("WrongPassword123!", savedUser.password)
        ).toBe(false);
    });

    it("should persist normalized email and name", async () => {
        const response = await api
            .post(endpoint)
            .send({
                ...validUser(),
                email: "  TEST@Example.COM  ",
                name: "  Test User  ",
            })
            .expect(201);

        expect(response.body.data.email).toBe("test@example.com");
        expect(response.body.data.name).toBe("Test User");

        expect(response.headers["set-cookie"]).toBeUndefined();
        expect(response.body.data).not.toHaveProperty("accessToken");

        const savedUser = await prisma.user.findUniqueOrThrow({
            where: { id: response.body.data.id },
        });

        expect(savedUser.email).toBe("test@example.com");
        expect(savedUser.name).toBe("Test User");
    });

    it("should reject case-insensitive duplicate registration", async () => {
        await api.post(endpoint).send(validUser()).expect(201);

        const response = await api
            .post(endpoint)
            .send({
                ...validUser(),
                email: "  TEST@EXAMPLE.COM  ",
            })
            .expect(409);

        expect(response.body.message).toBe("User already exists");
        expect(await prisma.user.count()).toBe(1);
    });

    it("should allow only one concurrent equivalent registration", async () => {
        const responses = await Promise.all([
            api.post(endpoint).send(validUser()),
            api.post(endpoint).send({
                ...validUser(),
                email: "  TEST@EXAMPLE.COM  ",
            }),
        ]);

        expect(
            responses.map(({ status }) => status).sort()
        ).toEqual([201, 409]);

        expect(
            responses.find(({ status }) => status === 409)?.body.message
        ).toBe("User already exists");

        expect(await prisma.user.count()).toBe(1);
    });

    it.each([
        { role: "ADMIN" },
        { roleId: "admin-role-id" },
        { permissions: ["user:update"] },
        { authVersion: 10 },
        { unsupportedField: true },
    ])("should reject prohibited registration fields: %j", async (fields) => {
        await api
            .post(endpoint)
            .send({
                ...validUser(),
                ...fields,
            })
            .expect(400);

        expect(await prisma.user.count()).toBe(0);
    });

    it.each(["ADMIN", "EMPLOYEE", undefined])(
        "should assign USER independently of DEFAULT_USER_ROLE=%s",
        async (defaultRole) => {
            await prisma.role.createMany({
                data: [
                    { name: "ADMIN" },
                    { name: "EMPLOYEE" },
                ],
            });

            vi.stubEnv("DEFAULT_USER_ROLE", defaultRole);

            const response = await api
                .post(endpoint)
                .send(validUser())
                .expect(201);

            expect(response.body.data.role.name).toBe("USER");

            const savedUser = await prisma.user.findUniqueOrThrow({
                where: { id: response.body.data.id },
                include: { role: true },
            });

            expect(savedUser.role.name).toBe("USER");
        }
    );

    it("should fail safely when USER role does not exist", async () => {
        await prisma.role.delete({
            where: { name: "USER" },
        });

        await prisma.role.create({
            data: { name: "ADMIN" },
        });

        vi.stubEnv("DEFAULT_USER_ROLE", "ADMIN");

        const response = await api
            .post(endpoint)
            .send(validUser())
            .expect(500);

        expect(response.body.message)
            .toBe("Default USER role is not configured");

        expect(await prisma.user.count()).toBe(0);
    });

    it.each([
        "a".repeat(72),
        "é".repeat(36),
    ])("should accept passwords containing exactly 72 bytes", async (password) => {
        await api
            .post(endpoint)
            .send({
                ...validUser(),
                password,
            })
            .expect(201);

        const user = await prisma.user.findUniqueOrThrow({
            where: { email: validUser().email },
        });

        expect(await bcrypt.compare(password, user.password!))
            .toBe(true);
    });

    it.each([
        "a".repeat(73),
        "é".repeat(36) + "a",
    ])("should reject passwords exceeding 72 bytes", async (password) => {
        await api
            .post(endpoint)
            .send({
                ...validUser(),
                password,
            })
            .expect(400);

        expect(await prisma.user.count()).toBe(0);
    });

    it("should enforce case-insensitive uniqueness in PostgreSQL", async () => {
        const role = await prisma.role.findUniqueOrThrow({
            where: { name: "USER" },
        });

        await prisma.user.create({
            data: {
                email: "test@example.com",
                roleId: role.id,
            },
        });

        await expect(
            prisma.user.create({
                data: {
                    email: "TEST@EXAMPLE.COM",
                    roleId: role.id,
                },
            })
        ).rejects.toMatchObject({
            code: "P2002",
        });

        expect(await prisma.user.count()).toBe(1);
    });
});
