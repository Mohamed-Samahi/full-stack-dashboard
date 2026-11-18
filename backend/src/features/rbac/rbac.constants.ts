const PREDEFINED_ROLES = [
    "ADMIN",
    "EMPLOYEE",
    "USER",
] as const;

type PredefinedRole = typeof PREDEFINED_ROLES[number];

const PERMISSIONS = {
    TICKET_CREATE: "ticket:create",
    TICKET_READ: "ticket:read",
    TICKET_UPDATE: "ticket:update",
    TICKET_ASSIGN: "ticket:assign",
    TICKET_SELF_ASSIGN: "ticket:self-assign",
    TICKET_TRANSITION: "ticket:transition",
    TICKET_COMMENT: "ticket:comment",
    TICKET_ATTACH: "ticket:attach",

    USER_READ: "user:read",
    USER_UPDATE: "user:update",

    ROLE_READ: "role:read",
    PERMISSION_READ: "permission:read",
} as const;

type PermissionKey =
    typeof PERMISSIONS[keyof typeof PERMISSIONS];

const PERMISSION_DEFINITIONS: Record<PermissionKey, string> = {
    [PERMISSIONS.TICKET_CREATE]: "Create tickets",
    [PERMISSIONS.TICKET_READ]: "Read tickets",
    [PERMISSIONS.TICKET_UPDATE]: "Update tickets",
    [PERMISSIONS.TICKET_ASSIGN]: "Assign tickets",
    [PERMISSIONS.TICKET_SELF_ASSIGN]: "Self-assign tickets",
    [PERMISSIONS.TICKET_TRANSITION]: "Change ticket status",
    [PERMISSIONS.TICKET_COMMENT]: "Comment on tickets",
    [PERMISSIONS.TICKET_ATTACH]: "Upload ticket attachments",

    [PERMISSIONS.USER_READ]: "Read users",
    [PERMISSIONS.USER_UPDATE]: "Update user roles",

    [PERMISSIONS.ROLE_READ]: "Read roles",
    [PERMISSIONS.PERMISSION_READ]: "Read permissions",
};

const SHARED_TICKET_PERMISSIONS = [
    PERMISSIONS.TICKET_CREATE,
    PERMISSIONS.TICKET_READ,
    PERMISSIONS.TICKET_UPDATE,
    PERMISSIONS.TICKET_TRANSITION,
    PERMISSIONS.TICKET_COMMENT,
    PERMISSIONS.TICKET_ATTACH,
] as const;

const ROLE_PERMISSIONS = {
    ADMIN: [
        ...SHARED_TICKET_PERMISSIONS,
        PERMISSIONS.TICKET_ASSIGN,
        PERMISSIONS.USER_READ,
        PERMISSIONS.USER_UPDATE,
        PERMISSIONS.ROLE_READ,
        PERMISSIONS.PERMISSION_READ,
    ],

    EMPLOYEE: [
        ...SHARED_TICKET_PERMISSIONS,
        PERMISSIONS.TICKET_SELF_ASSIGN,
    ],

    USER: [
        ...SHARED_TICKET_PERMISSIONS,
    ],
} as const satisfies Record<
    PredefinedRole,
    readonly PermissionKey[]
>;

const isPredefinedRole = (
    role: string
): role is PredefinedRole => {
    return PREDEFINED_ROLES.some(
        (predefinedRole) => predefinedRole === role
    );
};

export {
    PREDEFINED_ROLES,
    PERMISSIONS,
    PERMISSION_DEFINITIONS,
    ROLE_PERMISSIONS,
    isPredefinedRole,
};

export type {
    PredefinedRole,
    PermissionKey,
};