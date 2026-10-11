#!/usr/bin/env node
/**
 * One-time helper: opens the Google consent screen, catches the redirect on
 * http://localhost:53682 and prints GOOGLE_REFRESH_TOKEN.
 *
 * Usage:
 *   1. Put GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.local (or export them).
 *   2. npm run get-token
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { google } from "googleapis";

const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}`;
const SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
];
const TIMEOUT_MS = 5 * 60 * 1000;

function loadEnvFile(name) {
  const path = resolve(process.cwd(), name);
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key, raw] = match;
    if (process.env[key]) continue;
    process.env[key] = raw.replace(/^(['"])(.*)\1$/, "$2");
  }
}

loadEnvFile(".env.local");
loadEnvFile(".env");

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (in .env.local or your shell) first.");
  process.exit(1);
}

const oauth = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
const state = randomBytes(16).toString("hex");

const authUrl = oauth.generateAuthUrl({
  access_type: "offline",
  prompt: "consent", // forces Google to issue a refresh token every time
  scope: SCOPES,
  state,
});

function openBrowser(url) {
  const platform = process.platform;
  const [cmd, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The URL is printed below, so a failed auto-open is fine.
  }
}

function page(title, message) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>${title}</h1><p>${message}</p></body>`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", REDIRECT_URI);
  if (url.pathname !== "/") {
    res.writeHead(404).end();
    return;
  }

  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");

  if (error) {
    res.writeHead(400, { "Content-Type": "text/html" }).end(page("Authorisation failed", error));
    console.error(`\nGoogle returned an error: ${error}`);
    shutdown(1);
    return;
  }
  if (!code) {
    res.writeHead(400, { "Content-Type": "text/html" }).end(page("Waiting", "No code in this request."));
    return;
  }
  if (url.searchParams.get("state") !== state) {
    res.writeHead(400, { "Content-Type": "text/html" }).end(page("Rejected", "State mismatch."));
    console.error("\nState mismatch — ignoring that request.");
    return;
  }

  try {
    const { tokens } = await oauth.getToken(code);
    if (!tokens.refresh_token) {
      res
        .writeHead(500, { "Content-Type": "text/html" })
        .end(page("No refresh token", "Google did not return one. See the terminal."));
      console.error(
        "\nGoogle did not return a refresh token. Remove this app at https://myaccount.google.com/permissions and run the script again.",
      );
      shutdown(1);
      return;
    }
    res
      .writeHead(200, { "Content-Type": "text/html" })
      .end(page("All set ✓", "You can close this tab and go back to the terminal."));
    console.log("\nSuccess! Add this to your environment (.env.local and Vercel):\n");
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    shutdown(0);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/html" }).end(page("Token exchange failed", "See the terminal."));
    console.error("\nToken exchange failed:", err instanceof Error ? err.message : err);
    shutdown(1);
  }
});

let timer;
function shutdown(code) {
  clearTimeout(timer);
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 500).unref();
}

server.on("error", (err) => {
  console.error(`Could not listen on port ${PORT}:`, err.message);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log("Opening your browser to authorise Google Drive + Sheets access…");
  console.log("If it does not open, visit this URL manually:\n");
  console.log(authUrl + "\n");
  openBrowser(authUrl);
  timer = setTimeout(() => {
    console.error("Timed out after 5 minutes waiting for authorisation.");
    shutdown(1);
  }, TIMEOUT_MS);
});
