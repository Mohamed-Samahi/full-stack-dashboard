import { OAuth2Client } from "google-auth-library";
import { AppError } from "../errors/AppError.js";

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const redirectUri = process.env.GOOGLE_CALLBACK_URL;

export const googleOAuthClient =
    clientId && clientSecret && redirectUri
        ? new OAuth2Client({
            clientId,
            clientSecret,
            redirectUri,
        })
        : null;

export const getGoogleOAuthClient = () => {
    if (!googleOAuthClient) {
        throw new AppError(
            "Google OAuth is unavailable",
            503
        );
    }

    return googleOAuthClient;
};