import { app } from "./app";
import { config } from "./config";

app.listen(config.PORT, () => {
  console.log(`HTTP server listening on port ${config.PORT}`);
});
