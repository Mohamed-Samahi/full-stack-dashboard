import { createClient } from "@supabase/supabase-js";

import { AppError } from "../errors/AppError.js";

const STORAGE_TIMEOUT_MS = 10_000;

const SIGNED_URL_TTL_SECONDS = 60;

const MAX_FILE_SIZE = 10 * 1024 * 1024;

const MAX_ATTACHMENTS = Number(
    process.env.ATTACHMENT_MAX_COUNT ?? "10"
);

if (
    !Number.isSafeInteger(MAX_ATTACHMENTS) ||
    MAX_ATTACHMENTS <= 0
) {
    throw new Error("Invalid ATTACHMENT_MAX_COUNT");
}

const ALLOWED_MIME_TYPES = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "application/pdf",
] as const;

let client: ReturnType<typeof createClient> | undefined;

const getStorageBucket = () => {
    const url = process.env.SUPABASE_URL;
    const secret = process.env.SUPABASE_SECRET_KEY;
    const bucket = process.env.SUPABASE_STORAGE_BUCKET;

    if (!url || !secret || !bucket) {
        throw new AppError(
            "Storage service unavailable",
            503
        );
    }

    if (!client) {
        client = createClient(url, secret, {
            auth: {
                persistSession: false,
                autoRefreshToken: false,
                detectSessionInUrl: false,
            },

            global: {
                fetch: (input, init) => {
                    const timeout = AbortSignal.timeout(
                        STORAGE_TIMEOUT_MS
                    );

                    const signal = init?.signal
                        ? AbortSignal.any([
                            init.signal,
                            timeout,
                        ])
                        : timeout;

                    return fetch(input, {
                        ...init,
                        signal,
                    });
                },
            },
        });
    }

    return client.storage.from(bucket);
};

export {
    getStorageBucket,
    STORAGE_TIMEOUT_MS,
    SIGNED_URL_TTL_SECONDS,
    MAX_FILE_SIZE,
    MAX_ATTACHMENTS,
    ALLOWED_MIME_TYPES,
};