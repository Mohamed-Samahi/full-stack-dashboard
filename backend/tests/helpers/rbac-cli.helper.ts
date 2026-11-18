import { execFile } from "node:child_process";

import {
    assertTestEnvironment,
} from "../setup/testGuard.js";

type CliScript =
    | "prisma/seed.ts"
    | "prisma/provision-admin.ts";

type CliOptions = {
    production?: boolean;
    redisFailure?: boolean;
    adminEmail?: string;
    adminPassword?: string;
};

type CliResult = {
    exitCode: number;
    stdout: string;
    stderr: string;
};

export function runRbacCli(
    script: CliScript,
    options: CliOptions = {}
): Promise<CliResult> {
    assertTestEnvironment();

    const redisUrl = new URL(process.env.REDIS_URL!);

    if (options.redisFailure) {
        // Invalid database index on the isolated Redis server.
        redisUrl.pathname = "/999999";
    }

    return new Promise((resolve, reject) => {
        execFile(
            process.execPath,
            ["--import", "tsx", script],
            {
                cwd: process.cwd(),

                env: {
                    ...process.env,
                    NODE_ENV: options.production
                        ? "production"
                        : "test",

                    DATABASE_URL: process.env.DATABASE_URL,
                    REDIS_URL: redisUrl.toString(),

                    ADMIN_EMAIL: options.adminEmail ?? "",
                    ADMIN_PASSWORD: options.adminPassword ?? "",
                },

                timeout: 40000,
                encoding: "utf8",
            },
            (error, stdout, stderr) => {
                if (error && typeof error.code !== "number") {
                    reject(error);
                    return;
                }

                resolve({
                    exitCode: typeof error?.code === "number" ? error.code : 0,
                    stdout,
                    stderr,
                });
            }
        );
    });
}