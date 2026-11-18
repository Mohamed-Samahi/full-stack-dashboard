const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aElkAAAAASUVORK5CYII=",
    "base64"
);

const JPEG = Buffer.from(
    "ffd8ffe000104a46494600010100000100010000ffd9",
    "hex"
);

const WEBP = Buffer.from(
    "524946461a000000574542505650384c0d0000002f000000000710fd8ffe070000",
    "hex"
);

const PDF = Buffer.from(
    "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF"
);

const INVALID = Buffer.from(
    "This is not a supported binary file."
);

const validFileFixtures = [
    {
        buffer: PNG,
        fileName: "image.png",
        mimeType: "image/png",
    },
    {
        buffer: JPEG,
        fileName: "image.jpg",
        mimeType: "image/jpeg",
    },
    {
        buffer: WEBP,
        fileName: "image.webp",
        mimeType: "image/webp",
    },
    {
        buffer: PDF,
        fileName: "document.pdf",
        mimeType: "application/pdf",
    },
] as const;

const createMulterFile = (
    overrides: Partial<Express.Multer.File> = {}
): Express.Multer.File => {
    return {
        fieldname: "file",
        originalname: "image.png",
        encoding: "7bit",
        mimetype: "image/png",
        buffer: PNG,
        size: PNG.length,
        ...overrides,
    } as Express.Multer.File;
};

export {
    PNG,
    JPEG,
    WEBP,
    PDF,
    INVALID,
    validFileFixtures,
    createMulterFile,
};