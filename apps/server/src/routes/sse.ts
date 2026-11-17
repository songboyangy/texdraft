import type { FastifyReply } from 'fastify';

/** 接管响应并以 Server-Sent Events 输出 */
export function openSse(reply: FastifyReply) {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // 关闭 Nginx 缓冲
  });
  res.flushHeaders?.();
  let closed = false;
  res.on('close', () => {
    closed = true;
  });
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 15000);
  return {
    send(data: unknown) {
      if (!closed) res.write(`data: ${JSON.stringify(data)}\n\n`);
    },
    end() {
      clearInterval(heartbeat);
      if (!closed) res.end();
    },
    onClose(fn: () => void) {
      res.on('close', () => {
        clearInterval(heartbeat);
        fn();
      });
    },
    get closed() {
      return closed;
    },
  };
}
