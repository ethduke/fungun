import { createServer } from "node:http";
import { isIP } from "node:net";
import { LaunchImageProcessor } from "./launch-image.mjs";
import { createDecoderHandler, canonicalClient } from "./decoder-service.mjs";
import { verifyDecoderRuntime } from "./decoder-runtime.mjs";

try {
  const production = process.env.NODE_ENV === "production";
  const allowed = canonicalClient(process.env.DECODER_ALLOWED_CLIENT);
  if (production) {
    verifyDecoderRuntime();
    if (isIP(allowed) !== 6 || !allowed.startsWith("fdaa:")) throw new Error();
  } else if (allowed !== "127.0.0.1") throw new Error();
  const server = createServer(
    { maxHeaderSize: 4096 },
    createDecoderHandler(allowed, new LaunchImageProcessor()),
  );
  server.maxConnections = 4;
  server.requestTimeout = 8000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("error", () => {
    console.error("Image decoder could not listen.");
    process.exitCode = 1;
  });
  server.listen({ port: 8791, host: production ? "::" : "127.0.0.1", ipv6Only: production }, () =>
    console.log("Image decoder ready."),
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => server.close(() => process.exit(0)));
} catch {
  console.error("Image decoder refused unsafe runtime or configuration.");
  process.exitCode = 1;
}
