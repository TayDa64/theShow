/**
 * Desktop entry. Importing mcp/server.ts does not start stdio; this file does.
 * The HTTP server is mcp/http-server.ts so the stdio bundle does not include it.
 */
import { startStdioServer } from "./server.ts";

startStdioServer().catch((err) => {
  console.error(err);
  process.exit(1);
});
