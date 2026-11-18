import {
    createServer,
    get,
} from "node:http";

import type {
    Server,
    IncomingMessage,
    ClientRequest,
    ServerResponse,
} from "node:http";

import type {
    AddressInfo,
} from "node:net";

import {
    afterAll,
    afterEach,
    beforeAll,
    vi,
} from "vitest";

import app from "../../src/app.js";

import type {
    TicketCommentEventMap,
} from "../../src/features/tickets/ticket.types.js";

type EventName = keyof TicketCommentEventMap;

type SSEEvent = {
    [Name in EventName]: {
        event: Name;
        data: TicketCommentEventMap[Name];
    };
}[EventName];

const EVENT_TIMEOUT_MS = 5000;

class SSEConnection {
    private readonly request: ClientRequest;
    private readonly response: IncomingMessage;

    private buffer = "";

    readonly events: SSEEvent[] = [];

    heartbeatCount = 0;
    closed = false;

    constructor(
        request: ClientRequest,
        response: IncomingMessage
    ) {
        this.request = request;
        this.response = response;

        response.setEncoding("utf8");

        response.on("data", (chunk: string) => {
            this.consume(chunk);
        });

        response.on("end", () => {
            this.closed = true;
        });

        response.on("close", () => {
            this.closed = true;
        });

        response.on("error", () => {
            this.closed = true;
        });

        request.on("error", () => {
            this.closed = true;
        });
    }

    private consume(chunk: string): void {
        this.buffer += chunk;

        let separator = this.buffer.indexOf("\n\n");

        while (separator !== -1) {
            const frame = this.buffer.slice(
                0,
                separator
            );

            this.buffer = this.buffer.slice(
                separator + 2
            );

            this.parseFrame(frame);

            separator = this.buffer.indexOf("\n\n");
        }
    }

    private parseFrame(frame: string): void {
        const lines = frame.split("\n");

        if (
            lines.some(
                (line) => line.startsWith(": heartbeat")
            )
        ) {
            this.heartbeatCount += 1;
        }

        const event = lines
            .find((line) => line.startsWith("event:"))
            ?.slice(6)
            .trim();

        const data = lines
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");

        if (!event || !data) {
            return;
        }

        this.events.push({
            event,
            data: JSON.parse(data),
        } as SSEEvent);
    }

    async nextEvent<Name extends EventName>(
        name: Name,
        timeout = EVENT_TIMEOUT_MS
    ): Promise<{
        event: Name;
        data: TicketCommentEventMap[Name];
    }> {
        return vi.waitFor(
            () => {
                const index = this.events.findIndex(
                    (event) => event.event === name
                );

                if (index === -1) {
                    throw new Error(
                        `Waiting for SSE event: ${name}`
                    );
                }

                return this.events.splice(
                    index,
                    1
                )[0] as {
                    event: Name;
                    data: TicketCommentEventMap[Name];
                };
            },
            {
                timeout,
                interval: 20,
            }
        );
    }

    async waitUntilClosed(): Promise<void> {
        await vi.waitFor(
            () => {
                if (!this.closed) {
                    throw new Error(
                        "Waiting for SSE connection to close"
                    );
                }
            },
            {
                timeout: EVENT_TIMEOUT_MS,
                interval: 20,
            }
        );
    }

    close(): void {
        this.response.destroy();
        this.request.destroy();
        this.closed = true;
    }
}

export function setupSSETests() {
    let server: Server;
    let origin: string;

    const connections = new Set<SSEConnection>();
    const activeResponses = new Set<ServerResponse>();

    beforeAll(async () => {
        server = createServer(app);

        server.prependListener(
            "request",
            (_request, response) => {
                activeResponses.add(response);

                response.once("close", () => {
                    activeResponses.delete(response);
                });
            }
        );

        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);

            server.listen(0, "127.0.0.1", () => {
                server.off("error", reject);
                resolve();
            });
        });

        const address = server.address() as AddressInfo;

        origin = `http://127.0.0.1:${address.port}`;
    });

    afterEach(async () => {
        for (const connection of connections) {
            connection.close();
        }

        connections.clear();

        server.closeAllConnections();

        // Wait for server-side connection cleanup before
        // the next test resets the database.
        await vi.waitFor(
            () => {
                if (activeResponses.size !== 0) {
                    throw new Error(
                        "Waiting for server-side SSE cleanup"
                    );
                }
            },
            {
                timeout: EVENT_TIMEOUT_MS,
                interval: 20,
            }
        );
    });

    afterAll(async () => {
        server.closeAllConnections();

        await new Promise<void>((resolve, reject) => {
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve();
            });
        });
    });

    const subscribe = (
        ticketId: string,
        token: string
    ): Promise<SSEConnection> => {
        return new Promise((resolve, reject) => {
            const request = get(
                `${origin}/api/v1/tickets/${ticketId}/comments/events`,
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        Accept: "text/event-stream",
                    },
                    agent: false,
                },
                (response) => {
                    if (response.statusCode !== 200) {
                        response.resume();
                        request.destroy();

                        reject(
                            new Error(
                                `Unexpected SSE status: ${response.statusCode}`
                            )
                        );

                        return;
                    }

                    if (
                        !response.headers["content-type"]
                            ?.startsWith("text/event-stream")
                    ) {
                        response.destroy();
                        request.destroy();

                        reject(
                            new Error(
                                "Unexpected SSE content type"
                            )
                        );

                        return;
                    }

                    request.setTimeout(0);

                    const connection = new SSEConnection(
                        request,
                        response
                    );

                    connections.add(connection);

                    resolve(connection);
                }
            );

            request.setTimeout(
                EVENT_TIMEOUT_MS,
                () => {
                    request.destroy(
                        new Error(
                            "SSE connection timed out"
                        )
                    );
                }
            );

            request.once("error", reject);
        });
    };

    return {
        subscribe,
    };
}