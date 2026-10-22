// The stack is started separately (./stack.sh) so its PIDs are known and killed by PID afterwards.
// Fail loudly if it isn't up instead of testing nothing.
export const URLS = { gateway: 'http://127.0.0.1:8405', gatewayAdmin: 'http://127.0.0.1:8406', dashboard: 'http://127.0.0.1:5183', landing: 'http://127.0.0.1:5184' };

export default async function globalSetup() {
  for (const u of [`${URLS.gateway}/api/info`, `${URLS.gatewayAdmin}/api/info`, `${URLS.dashboard}/`, `${URLS.landing}/`]) {
    const r = await fetch(u).catch((e) => {
      throw new Error(`Kippu stack not running (${u}: ${e.cause?.code || e.message}). Start it with: npm run stack`);
    });
    if (!r.ok) throw new Error(`${u} answered ${r.status}; restart the stack (npm run stack:stop && npm run stack)`);
  }
}
