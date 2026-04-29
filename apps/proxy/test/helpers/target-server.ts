import http from "node:http";
import type { AddressInfo } from "node:net";

export interface TargetHandlerArgs {
  method: string;
  url: string;
  headers: NodeJS.Dict<string | string[]>;
  body: Buffer;
}

export type TargetHandler = (
  args: TargetHandlerArgs,
  res: http.ServerResponse,
) => void | Promise<void>;

export interface RunningTarget {
  port: number;
  host: string;            // "127.0.0.1:PORT" — for direct loopback use
  localhostHost: string;   // "localhost:PORT" — passes the proxy allowlist when "localhost" is allowed
  url: (path?: string) => string;          // http://127.0.0.1:PORT...
  localhostUrl: (path?: string) => string; // http://localhost:PORT...
  close(): Promise<void>;
}

export async function startTargetServer(handler: TargetHandler): Promise<RunningTarget> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void Promise.resolve(
        handler(
          {
            method: req.method ?? "GET",
            url: req.url ?? "/",
            headers: req.headers,
            body: Buffer.concat(chunks),
          },
          res,
        ),
      ).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end(String(err));
        }
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const port = addr.port;

  return {
    port,
    host: `127.0.0.1:${port}`,
    localhostHost: `localhost:${port}`,
    url: (path = "/") => `http://127.0.0.1:${port}${path}`,
    localhostUrl: (path = "/") => `http://localhost:${port}${path}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
