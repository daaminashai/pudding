// `npm start`: open the review dashboard and check the inbox straight away.
// `npm run scan`: check the inbox and write drafts without starting the dashboard.
import "./env.js";
import path from "node:path";
import { loadConfig } from "./config.js";
import { AnthropicDrafter } from "./llm.js";
import { OpenAIDrafter } from "./llm-openai.js";
import { acquireLock } from "./lock.js";
import { log } from "./log.js";
import { MarmaladeClient } from "./marmalade.js";
import { errorMessage } from "./redact.js";
import { scan } from "./scan.js";
import { JellyClient } from "./jelly.js";
import { JellySender, ManualSender, type Sender } from "./send.js";
import { Dashboard } from "./server.js";
import { State } from "./state.js";

async function main(): Promise<number> {
  const scanOnly = process.argv.includes("--scan-only");
  const config = loadConfig(process.env);
  const release = acquireLock(config.dataDir);
  const state = new State(path.join(config.dataDir, "state.db"));
  const deps = {
    config,
    marmalade: new MarmaladeClient(config.marmalade),
    drafter:
      config.llm.provider === "openai" ? new OpenAIDrafter(config.llm.model) : new AnthropicDrafter(config.llm.model),
    state,
    sender: makeSender(config),
  };
  const cleanup = () => {
    state.close();
    release();
  };

  if (scanOnly) {
    try {
      const { progress } = await scan(deps, (p) => log.info(p.message));
      for (const e of progress.errors) log.warn(e);
      return progress.errors.length > 0 ? 1 : 0;
    } finally {
      cleanup();
    }
  }

  const dashboard = new Dashboard(deps);
  const server = dashboard.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.dashboardPort, "127.0.0.1", resolve);
  });
  log.info(
    `Dashboard: http://localhost:${config.dashboardPort} (drafting with ${config.llm.provider} ${config.llm.model}; ` +
      `${config.mode === "send" ? "approving sends through Jelly" : "approving copies the reply"})`,
  );
  void dashboard.startScan();

  await new Promise<void>((resolve) => {
    const stop = () => {
      log.info("shutting down");
      server.close(() => resolve());
      server.closeAllConnections();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  cleanup();
  return 0;
}

function makeSender(config: ReturnType<typeof loadConfig>): Sender {
  if (config.mode !== "send" || !config.jelly.cookie) return new ManualSender(config.killSwitch, config.workDir);
  const client = new JellyClient({ ...config.jelly, cookie: config.jelly.cookie });
  return new JellySender(client, {
    killSwitch: config.killSwitch,
    workDir: config.workDir,
    slackWebhookUrl: config.slackWebhookUrl,
  });
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log.error(errorMessage(err));
    process.exit(1);
  });
