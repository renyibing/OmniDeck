import { ControlDaemon } from './controlDaemon';

const daemon = new ControlDaemon();
const port = Number(process.env.OMNIDECK_PORT ?? 4317);
await daemon.listen({ host: process.env.OMNIDECK_HOST ?? '127.0.0.1', port });
console.log(`OmniDeck Control Daemon listening on http://127.0.0.1:${port}`);

const shutdown = async () => { await daemon.close(); process.exit(0); };
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
