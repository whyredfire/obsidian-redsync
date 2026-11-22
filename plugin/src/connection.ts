import { requestUrl } from "obsidian";
import type { ApiErrorBody } from "./protocol/ApiErrorBody";
import type { ClientMessage } from "./protocol/ClientMessage";
import type { CommitOp } from "./protocol/CommitOp";
import type { CommitResult } from "./protocol/CommitResult";
import type { Listing } from "./protocol/Listing";
import type { ServerMessage } from "./protocol/ServerMessage";
import type { Cursor } from "./state";

const PROTOCOL_VERSION = 1;
const COMMIT_TIMEOUT_MS = 30_000;
const PING_EVERY_MS = 20_000;
const PONG_WITHIN_MS = 10_000;

export interface Account {
    serverUrl: string;
    vaultId: string;
    deviceId: string;
    token: string;
}

export class ServerError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
    ) {
        super(message);
    }
}

/** One HTTP call to the server's API, with JSON in and out. Uses Obsidian's requestUrl, which is not subject to CORS. */
export async function call<T>(serverUrl: string, method: string, path: string, options: { token?: string; json?: unknown } = {}): Promise<T> {
    let response;
    try {
        response = await requestUrl({
            url: `${serverUrl.replace(/\/+$/, "")}/v1${path}`,
            method,
            headers: options.token ? { Authorization: `Bearer ${options.token}` } : {},
            body: options.json === undefined ? undefined : JSON.stringify(options.json),
            contentType: "application/json",
            throw: false,
        });
    } catch (error) {
        throw new ServerError(0, "unreachable", `The server cannot be reached (${String(error)}).`);
    }
    if (response.status >= 400) throw errorOf(response.status, response);
    return (response.text ? response.json : undefined) as T;
}

function errorOf(status: number, response: { json: unknown }): ServerError {
    let body: ApiErrorBody | undefined;
    try {
        body = response.json as ApiErrorBody;
    } catch {
        // Not a JSON error body.
    }
    return new ServerError(status, body?.error ?? "http", body?.message ?? `HTTP ${status}`);
}

/** The vault's blob and listing routes for a connected device. */
export class Server {
    constructor(private readonly account: Account) {}

    async putBlob(id: string, data: ArrayBuffer): Promise<void> {
        await this.request("PUT", `/blobs/${id}`, data);
    }

    async getBlob(id: string): Promise<ArrayBuffer> {
        return (await this.request("GET", `/blobs/${id}`)).arrayBuffer;
    }

    async listing(): Promise<Listing> {
        return (await this.request("GET", "/files")).json as Listing;
    }

    private async request(method: string, path: string, body?: ArrayBuffer) {
        const response = await requestUrl({
            url: `${this.account.serverUrl.replace(/\/+$/, "")}/v1/vaults/${this.account.vaultId}${path}`,
            method,
            headers: { Authorization: `Bearer ${this.account.token}` },
            body,
            contentType: body ? "application/octet-stream" : undefined,
            throw: false,
        });
        if (response.status >= 400) throw errorOf(response.status, response);
        return response;
    }
}

export interface SocketHandlers {
    message(message: Exclude<ServerMessage, { type: "result" } | { type: "pong" }>): void;
    /** Close codes 4001 (unauthorized) and 4003 (revoked) stop reconnecting. */
    closed(code: number): void;
}

/** The WebSocket to the server: hello, commits, and reconnecting with back-off. */
export class Socket {
    connected = false;
    private ws?: WebSocket;
    private stopped = true;
    private retryMs = 1000;
    private retryTimer?: number;
    private pingTimer?: number;
    private pongTimer?: number;
    private pending = new Map<string, { resolve: (results: CommitResult[]) => void; reject: (error: Error) => void }>();

    constructor(
        private readonly account: Account,
        private readonly cursor: () => Cursor,
        private readonly handlers: SocketHandlers,
    ) {}

    start(): void {
        this.stopped = false;
        this.open();
    }

    stop(): void {
        this.stopped = true;
        window.clearTimeout(this.retryTimer);
        this.drop();
    }

    /** Closes and reconnects at once, e.g. after a reconciliation or when the app comes back. */
    restart(): void {
        if (this.stopped) return;
        window.clearTimeout(this.retryTimer);
        this.drop();
        this.open();
    }

    commit(ops: CommitOp[]): Promise<CommitResult[]> {
        const ws = this.ws;
        if (!this.connected || !ws) return Promise.reject(new Error("not connected"));
        const req = crypto.randomUUID();
        return new Promise((resolve, reject) => {
            const timer = window.setTimeout(() => {
                this.pending.delete(req);
                reject(new Error("no answer to a commit"));
                this.restart();
            }, COMMIT_TIMEOUT_MS);
            this.pending.set(req, {
                resolve: (results) => (window.clearTimeout(timer), resolve(results)),
                reject: (error) => (window.clearTimeout(timer), reject(error)),
            });
            this.send(ws, { type: "commit", req, ops });
        });
    }

    private open(): void {
        const ws = new WebSocket(`${this.account.serverUrl.replace(/\/+$/, "").replace(/^http/, "ws")}/v1/ws`);
        this.ws = ws;
        ws.onopen = () => {
            const cursor = this.cursor();
            this.send(ws, {
                type: "hello",
                vault: this.account.vaultId,
                token: this.account.token,
                epoch: cursor.epoch,
                since: cursor.seq,
                protocol: PROTOCOL_VERSION,
            });
        };
        ws.onmessage = (event) => {
            const message = JSON.parse(String(event.data)) as ServerMessage;
            window.clearTimeout(this.pongTimer);
            if (message.type === "result") {
                this.pending.get(message.req)?.resolve(message.results);
                this.pending.delete(message.req);
                return;
            }
            if (message.type === "pong") return;
            if (message.type === "welcome") {
                this.connected = true;
                this.retryMs = 1000;
                this.startPinging(ws);
            }
            this.handlers.message(message);
        };
        ws.onclose = (event) => {
            if (this.ws !== ws) return;
            this.drop();
            this.handlers.closed(event.code);
            if (event.code === 4001 || event.code === 4003) this.stopped = true;
            if (this.stopped) return;
            this.retryTimer = window.setTimeout(() => this.open(), this.retryMs);
            this.retryMs = Math.min(this.retryMs * 2, 30_000);
        };
    }

    /** Browsers cannot see WebSocket pings, so a silently dead connection is found with our own. */
    private startPinging(ws: WebSocket): void {
        window.clearInterval(this.pingTimer);
        this.pingTimer = window.setInterval(() => {
            this.send(ws, { type: "ping" });
            this.pongTimer = window.setTimeout(() => this.restart(), PONG_WITHIN_MS);
        }, PING_EVERY_MS);
    }

    private drop(): void {
        window.clearInterval(this.pingTimer);
        window.clearTimeout(this.pongTimer);
        const ws = this.ws;
        this.ws = undefined;
        this.connected = false;
        for (const { reject } of this.pending.values()) reject(new Error("disconnected"));
        this.pending.clear();
        if (ws) {
            ws.onclose = null;
            ws.onmessage = null;
            ws.onopen = null;
            ws.close();
        }
    }

    private send(ws: WebSocket, message: ClientMessage): void {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    }
}
