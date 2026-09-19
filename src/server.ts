import { app } from "./app";
import { config } from "./config";
import { prisma } from "./prisma";

const server = app.listen(config.PORT, () => {
  console.log(`HTTP server listening on port ${config.PORT}`);
});

function shutdown() {
  server.close(() => {
    void prisma.$disconnect();
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
