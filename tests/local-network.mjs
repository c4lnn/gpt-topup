import net from 'node:net';

// Test subprocesses have no remote HTTP, proxy, or raw TCP destinations.
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof first === 'number' ? (typeof args[1] === 'string' ? args[1] : 'localhost')
    : first && typeof first === 'object' && !first.path ? first.host ?? 'localhost' : undefined;
  if (host !== undefined && !['127.0.0.1', '::1', 'localhost'].includes(host)) {
    console.error('TEST_EGRESS_DENIED');
    process.exit(97);
  }
  return connect.apply(this, args);
};
