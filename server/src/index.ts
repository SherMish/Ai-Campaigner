import "dotenv/config";
import { createApp } from "./app.js";

const PORT = Number(process.env.PORT) || 4000;

createApp().listen(PORT, () => {
  console.log(`[server] AI Campaigner API listening on :${PORT}`);
});
