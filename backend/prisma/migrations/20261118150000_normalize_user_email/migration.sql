BEGIN;

-- Prevent concurrent user writes during normalization.
LOCK TABLE "User" IN SHARE ROW EXCLUSIVE MODE;

-- Abort if normalization would produce duplicate emails.
DO $$
BEGIN
    IF EXISTS (
        SELECT LOWER(
            REGEXP_REPLACE(
                "email",
                '^[[:space:]]+|[[:space:]]+$',
                '',
                'g'
            )
        )
        FROM "User"
        GROUP BY 1
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION
            'Duplicate normalized emails exist. Manual reconciliation is required.';
    END IF;
END $$;

-- Normalize existing email addresses.
UPDATE "User"
SET "email" = LOWER(
    REGEXP_REPLACE(
        "email",
        '^[[:space:]]+|[[:space:]]+$',
        '',
        'g'
    )
)
WHERE "email" <> LOWER(
    REGEXP_REPLACE(
        "email",
        '^[[:space:]]+|[[:space:]]+$',
        '',
        'g'
    )
);

-- Enforce case-insensitive email uniqueness.
CREATE UNIQUE INDEX "User_email_lower_key"
ON "User" (LOWER("email"));

COMMIT;