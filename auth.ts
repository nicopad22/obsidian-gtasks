import * as http from "http";
import * as crypto from "crypto";
import { Notice, requestUrl } from "obsidian";

export const LOOPBACK_HOST = "127.0.0.1";
export const LOOPBACK_PORT = 42813;
export const CALLBACK_PATH = "/callback";
export const REDIRECT_URI = `http://${LOOPBACK_HOST}:${LOOPBACK_PORT}${CALLBACK_PATH}`;

export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_TASKS_SCOPE = "https://www.googleapis.com/auth/tasks";

/** Refresh tokens 60 seconds before actual expiration */
const EXPIRY_BUFFER_MS = 60_000;
/** Timeout for the user to complete browser consent (2 minutes) */
const AUTH_TIMEOUT_MS = 120_000;

export interface OAuthTokenState {
	clientId: string;
	clientSecret: string;
	accessToken: string;
	refreshToken: string;
	tokenExpiry: number;
}

export interface TokenResponse {
	access_token: string;
	expires_in: number;
	refresh_token?: string;
	scope: string;
	token_type: string;
}

function base64UrlEncode(buffer: Buffer): string {
	return buffer
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function generatePkcePair(): { codeVerifier: string; codeChallenge: string } {
	const codeVerifier = base64UrlEncode(crypto.randomBytes(32));
	const hash = crypto.createHash("sha256").update(codeVerifier).digest();
	const codeChallenge = base64UrlEncode(hash);
	return { codeVerifier, codeChallenge };
}

export class GoogleAuthManager {
	private activeServer: http.Server | null = null;
	private refreshInFlight: Promise<string> | null = null;

	constructor(
		private getState: () => OAuthTokenState,
		private saveTokenState: (updated: Partial<OAuthTokenState>) => Promise<void>
	) {}

	/**
	 * Checks whether the plugin currently has OAuth credentials and a refresh or access token.
	 */
	public isAuthenticated(): boolean {
		const { accessToken, refreshToken } = this.getState();
		return Boolean(refreshToken || accessToken);
	}

	/**
	 * Starts the Desktop OAuth 2.0 loopback flow on 127.0.0.1:42813/callback,
	 * opens the system browser for user consent, exchanges the authorization code
	 * for access & refresh tokens using `requestUrl`, and persists them.
	 */
	public async startOAuthFlow(): Promise<void> {
		const { clientId, clientSecret } = this.getState();
		if (!clientId.trim() || !clientSecret.trim()) {
			throw new Error("Please configure your Google OAuth Client ID and Client Secret in plugin settings first.");
		}

		// Ensure any previous transient server is closed before binding 127.0.0.1:42813
		this.stopActiveServer();

		const state = base64UrlEncode(crypto.randomBytes(16));
		const { codeVerifier, codeChallenge } = generatePkcePair();

		await this.listenAndExchangeTokens(
			clientId.trim(),
			clientSecret.trim(),
			state,
			codeVerifier,
			codeChallenge
		);
	}

	/**
	 * Returns a valid access token, automatically refreshing it via the refresh token if expired.
	 */
	public async getValidAccessToken(): Promise<string> {
		const state = this.getState();

		if (
			state.accessToken &&
			state.tokenExpiry &&
			Date.now() + EXPIRY_BUFFER_MS < state.tokenExpiry
		) {
			return state.accessToken;
		}

		if (!state.refreshToken) {
			throw new Error(
				"Not authenticated with Google Tasks. Please authenticate in the plugin settings."
			);
		}

		if (!this.refreshInFlight) {
			this.refreshInFlight = this.refreshAccessToken().finally(() => {
				this.refreshInFlight = null;
			});
		}

		return this.refreshInFlight;
	}

	/**
	 * Clears stored OAuth tokens and stops any transient loopback server.
	 */
	public async revokeAndClearTokens(): Promise<void> {
		this.stopActiveServer();
		await this.saveTokenState({
			accessToken: "",
			refreshToken: "",
			tokenExpiry: 0,
		});
	}

	/**
	 * Stops the transient HTTP callback server if it is currently listening.
	 */
	public stopActiveServer(): void {
		if (this.activeServer) {
			try {
				this.activeServer.close();
			} catch {
				// Ignore errors during server teardown
			}
			this.activeServer = null;
		}
	}

	private listenAndExchangeTokens(
		clientId: string,
		clientSecret: string,
		expectedState: string,
		codeVerifier: string,
		codeChallenge: string
	): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const sockets = new Set<import("net").Socket>();
			let settled = false;

			const cleanup = () => {
				clearTimeout(timeoutId);
				for (const socket of sockets) {
					try {
						socket.destroy();
					} catch {
						// Ignore socket destroy errors
					}
				}
				sockets.clear();
				if (this.activeServer) {
					try {
						this.activeServer.close();
					} catch {
						// Ignore close errors
					}
					this.activeServer = null;
				}
			};

			const settleResolve = () => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve();
			};

			const settleReject = (err: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(err);
			};

			const server = http.createServer(async (req, res) => {
				try {
					const reqUrl = new URL(
						req.url || "/",
						`http://${LOOPBACK_HOST}:${LOOPBACK_PORT}`
					);

					if (reqUrl.pathname !== CALLBACK_PATH) {
						res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
						res.end("Not Found");
						return;
					}

					const error = reqUrl.searchParams.get("error");
					const code = reqUrl.searchParams.get("code");
					const returnedState = reqUrl.searchParams.get("state");

					if (error) {
						res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
						res.end(this.renderCallbackHtml(false, `Authorization failed: ${error}`));
						settleReject(new Error(`Google OAuth error: ${error}`));
						return;
					}

					if (!returnedState || returnedState !== expectedState) {
						res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
						res.end(this.renderCallbackHtml(false, "Invalid OAuth state parameter."));
						settleReject(new Error("OAuth state mismatch. Please try authenticating again."));
						return;
					}

					if (!code) {
						res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
						res.end(this.renderCallbackHtml(false, "Missing authorization code."));
						settleReject(new Error("No authorization code received from Google."));
						return;
					}

					await this.exchangeCodeForTokens(code, clientId, clientSecret, codeVerifier);

					res.writeHead(200, {
						"Content-Type": "text/html; charset=utf-8",
						"Connection": "close",
					});
					res.end(
						this.renderCallbackHtml(
							true,
							"Authentication successful! Tokens saved. You can close this window and return to Obsidian."
						)
					);
					settleResolve();
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					if (!res.headersSent) {
						res.writeHead(500, {
							"Content-Type": "text/html; charset=utf-8",
							"Connection": "close",
						});
						res.end(this.renderCallbackHtml(false, errMsg));
					}
					settleReject(err instanceof Error ? err : new Error(errMsg));
				}
			});

			server.on("connection", (socket) => {
				sockets.add(socket);
				socket.on("close", () => sockets.delete(socket));
			});

			server.on("error", (err) => {
				settleReject(
					new Error(`Failed to start local OAuth callback server on ${REDIRECT_URI}: ${err.message}`)
				);
			});

			const timeoutId = setTimeout(() => {
				settleReject(new Error("OAuth authentication timed out after 2 minutes."));
			}, AUTH_TIMEOUT_MS);

			this.activeServer = server;

			server.listen(LOOPBACK_PORT, LOOPBACK_HOST, () => {
				const params = new URLSearchParams({
					client_id: clientId,
					redirect_uri: REDIRECT_URI,
					response_type: "code",
					scope: GOOGLE_TASKS_SCOPE,
					access_type: "offline",
					prompt: "consent",
					state: expectedState,
					code_challenge: codeChallenge,
					code_challenge_method: "S256",
				});

				const authUrl = `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
				new Notice("Opening browser for Google Tasks authentication...");
				window.open(authUrl, "_blank");
			});
		});
	}

	private async exchangeCodeForTokens(
		code: string,
		clientId: string,
		clientSecret: string,
		codeVerifier: string
	): Promise<void> {
		const body = new URLSearchParams({
			code,
			client_id: clientId,
			client_secret: clientSecret,
			redirect_uri: REDIRECT_URI,
			grant_type: "authorization_code",
			code_verifier: codeVerifier,
		}).toString();

		const response = await requestUrl({
			url: GOOGLE_TOKEN_ENDPOINT,
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body,
			throw: false,
		});

		if (response.status < 200 || response.status >= 300) {
			throw new Error(
				`Failed to exchange authorization code for tokens (HTTP ${response.status}): ${response.text}`
			);
		}

		const data = response.json as TokenResponse;
		const currentState = this.getState();

		await this.saveTokenState({
			accessToken: data.access_token,
			refreshToken: data.refresh_token || currentState.refreshToken,
			tokenExpiry: Date.now() + data.expires_in * 1000,
		});
	}

	private async refreshAccessToken(): Promise<string> {
		const { clientId, clientSecret, refreshToken } = this.getState();

		if (!clientId.trim() || !clientSecret.trim() || !refreshToken) {
			throw new Error("Missing OAuth credentials or refresh token. Please re-authenticate.");
		}

		const body = new URLSearchParams({
			client_id: clientId.trim(),
			client_secret: clientSecret.trim(),
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		}).toString();

		const response = await requestUrl({
			url: GOOGLE_TOKEN_ENDPOINT,
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body,
			throw: false,
		});

		if (response.status < 200 || response.status >= 300) {
			throw new Error(
				`Failed to refresh Google access token (HTTP ${response.status}): ${response.text}`
			);
		}

		const data = response.json as TokenResponse;
		const updatedExpiry = Date.now() + data.expires_in * 1000;

		await this.saveTokenState({
			accessToken: data.access_token,
			...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
			tokenExpiry: updatedExpiry,
		});

		return data.access_token;
	}

	private renderCallbackHtml(success: boolean, message: string): string {
		const color = success ? "#2e7d32" : "#c62828";
		const title = success ? "Authentication Successful" : "Authentication Error";
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<title>${title} - Obsidian Google Tasks</title>
	<style>
		body {
			font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
			display: flex;
			align-items: center;
			justify-content: center;
			height: 100vh;
			margin: 0;
			background: #f5f5f5;
			color: #222;
		}
		.card {
			background: #fff;
			padding: 2rem 2.5rem;
			border-radius: 10px;
			box-shadow: 0 4px 16px rgba(0,0,0,0.08);
			max-width: 440px;
			text-align: center;
		}
		h1 {
			color: ${color};
			font-size: 1.4rem;
			margin-top: 0;
		}
		p {
			color: #555;
			line-height: 1.5;
		}
	</style>
</head>
<body>
	<div class="card">
		<h1>${title}</h1>
		<p>${message}</p>
	</div>
</body>
</html>`;
	}
}
