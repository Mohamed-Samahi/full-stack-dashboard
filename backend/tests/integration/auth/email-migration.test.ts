import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import pg from "pg";
import { describe, expect, it } from "vitest";

import {
    assertTestEnvironment,
} from "../../setup/testGuard.js";

const migrationName = "20261118150000_normalize_user_email";

const migrationsDirectory = resolve(
    "prisma",
    "migrations"
);

const readMigration = (name: string) =>
    readFile(
        resolve(migrationsDirectory, name, "migration.sql"),
        "utf8"
    );

const withLegacySchema = async (
    run: (client: pg.Client) => Promise<void>
) => {
    assertTestEnvironment();

    const schema = `migration_test_${randomUUID().replaceAll("-", "")}`;

    const client = new pg.Client({
        connectionString: process.env.DATABASE_URL,
    });

    await client.connect();

    try {
        await client.query(`CREATE SCHEMA "${schema}"`);

        await client.query(
            `SET search_path TO "${schema}"`
        );

        const directories = await readdir(
            migrationsDirectory,
            { withFileTypes: true }
        );

        const previousMigrations = directories
            .filter(
                (entry) =>
                    entry.isDirectory() &&
                    entry.name < migrationName
            )
            .map(({ name }) => name)
            .sort();

        // Reconstruct the actual pre-Feature-2 database schema.
        for (const migration of previousMigrations) {
            await client.query(
                await readMigration(migration)
            );
        }

        await client.query(`
            INSERT INTO "Role" (
                "id",
                "name",
                "updatedAt"
            )
            VALUES ('role-user', 'USER', NOW())
        `);

        await run(client);
    } finally {
        try {
            // Recover the connection if a migration failed
            // inside its explicit transaction.
            await client.query("ROLLBACK");

            await client.query(
                `DROP SCHEMA IF EXISTS "${schema}" CASCADE`
            );
        } finally {
            await client.end();
        }
    }
};

const insertUser = async (
    client: pg.Client,
    id: string,
    email: string
) => {
    await client.query(`
        INSERT INTO "User" (
            "id",
            "email",
            "roleId",
            "updatedAt"
        )
        VALUES ($1, $2, 'role-user', NOW())
    `, [id, email]);
};

describe("User Email Normalization Migration", () => {
    it("should normalize legacy emails and preserve relationships", async () => {
        await withLegacySchema(async (client) => {
            await insertUser(
                client,
                "user-one",
                "  USER@Example.COM  "
            );

            await insertUser(
                client,
                "user-two",
                "\tSECOND@Example.COM\n"
            );

            await client.query(`
                INSERT INTO "OAuthAccount" (
                    "id",
                    "provider",
                    "providerAccountId",
                    "userId",
                    "updatedAt"
                )
                VALUES (
                    'oauth-one',
                    'google',
                    'google-account-one',
                    'user-one',
                    NOW()
                )
            `);

            await client.query(`
                INSERT INTO "PasswordResetToken" (
                    "tokenHash",
                    "userId",
                    "expiresAt"
                )
                VALUES (
                    'existing-token-hash',
                    'user-one',
                    NOW() + INTERVAL '15 minutes'
                )
            `);

            const beforeUsers = await client.query(`
                SELECT * FROM "User"
                ORDER BY "id"
            `);

            const beforeOAuth = await client.query(`
                SELECT * FROM "OAuthAccount"
            `);

            const beforeResetTokens = await client.query(`
                SELECT * FROM "PasswordResetToken"
            `);

            await client.query(
                await readMigration(migrationName)
            );

            const afterUsers = await client.query(`
                SELECT * FROM "User"
                ORDER BY "id"
            `);

            expect(afterUsers.rows).toEqual([
                {
                    ...beforeUsers.rows[0],
                    email: "user@example.com",
                },
                {
                    ...beforeUsers.rows[1],
                    email: "second@example.com",
                },
            ]);

            const afterOAuth = await client.query(`
                SELECT * FROM "OAuthAccount"
            `);

            const afterResetTokens = await client.query(`
                SELECT * FROM "PasswordResetToken"
            `);

            expect(afterOAuth.rows).toEqual(beforeOAuth.rows);

            expect(afterResetTokens.rows)
                .toEqual(beforeResetTokens.rows);
        });
    }, 15000);

    it("should reject normalized email collisions without losing data", async () => {
        await withLegacySchema(async (client) => {
            await insertUser(
                client,
                "user-one",
                "User@Example.COM"
            );

            await insertUser(
                client,
                "user-two",
                "  user@example.com  "
            );

            await insertUser(
                client,
                "user-three",
                "  ANOTHER@Example.COM  "
            );

            const before = await client.query(`
                SELECT * FROM "User"
                ORDER BY "id"
            `);

            await expect(
                client.query(
                    await readMigration(migrationName)
                )
            ).rejects.toThrow(
                "Duplicate normalized emails exist"
            );

            await client.query("ROLLBACK");

            const after = await client.query(`
                SELECT * FROM "User"
                ORDER BY "id"
            `);

            expect(after.rows).toEqual(before.rows);

            const indexes = await client.query(`
                SELECT indexname
                FROM pg_indexes
                WHERE schemaname = current_schema()
                  AND tablename = 'User'
            `);

            expect(
                indexes.rows.map(({ indexname }) => indexname)
            ).not.toContain("User_email_lower_key");
        });
    }, 15000);

    it("should preserve both email uniqueness indexes", async () => {
        await withLegacySchema(async (client) => {
            await insertUser(
                client,
                "user-one",
                "user@example.com"
            );

            await client.query(
                await readMigration(migrationName)
            );

            const { rows } = await client.query(`
                SELECT indexname, indexdef
                FROM pg_indexes
                WHERE schemaname = current_schema()
                  AND tablename = 'User'
            `);

            const originalIndex = rows.find(
                ({ indexname }) =>
                    indexname === "User_email_key"
            );

            const expressionIndex = rows.find(
                ({ indexname }) =>
                    indexname === "User_email_lower_key"
            );

            expect(originalIndex?.indexdef)
                .toContain("CREATE UNIQUE INDEX");

            expect(expressionIndex?.indexdef)
                .toContain("CREATE UNIQUE INDEX");

            expect(expressionIndex?.indexdef)
                .toMatch(/lower\("?email"?\)/i);
        });
    }, 15000);
});