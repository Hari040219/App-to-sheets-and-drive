import { google, type Auth } from "googleapis";

let cachedClient: Auth.OAuth2Client | null = null;

export function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

/** OAuth2 client that acts as YOUR Google account via a stored refresh token. */
export function getAuth(): Auth.OAuth2Client {
  if (!cachedClient) {
    const client = new google.auth.OAuth2(env("GOOGLE_CLIENT_ID"), env("GOOGLE_CLIENT_SECRET"));
    client.setCredentials({ refresh_token: env("GOOGLE_REFRESH_TOKEN") });
    cachedClient = client;
  }
  return cachedClient;
}

export function getDrive() {
  return google.drive({ version: "v3", auth: getAuth() });
}

export function getSheets() {
  return google.sheets({ version: "v4", auth: getAuth() });
}

export async function getAccessToken(): Promise<string> {
  const { token } = await getAuth().getAccessToken();
  if (!token) throw new Error("Could not obtain a Google access token");
  return token;
}
