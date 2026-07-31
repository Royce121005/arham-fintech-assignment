'use strict';

// Minimal Server-Sent-Events hub. Chosen over WebSockets because updates
// only flow server->client (portal never needs to push data back over this
// channel), SSE auto-reconnects in the browser for free, and it works over
// plain HTTP - no extra infra. Every open tab holds one long-lived
// connection; when the poller commits fresh data it calls broadcast(), and
// every tab's client-side JS re-fetches just the affected view.

const clients = new Set();

function handleSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.write('retry: 2000\n\n');
  clients.add(res);

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}

function broadcast(event, payload) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    res.write(data);
  }
}

module.exports = { handleSSE, broadcast };
