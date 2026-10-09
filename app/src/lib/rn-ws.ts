// RN global WebSocket → core's SocketHandle. RN's WebSocket emits events;
// the handle adapts them into the callbacks WsClient drives.

import type { SocketFactory } from "@platform/core";

export const rnSocketFactory: SocketFactory = (url) => {
  const ws = new WebSocket(url);
  let handlers: {
    onOpen(): void;
    onMessage(data: string): void;
    onClose(): void;
    onError(): void;
  } | null = null;
  ws.onopen = () => handlers?.onOpen();
  ws.onmessage = (ev: WebSocketMessageEvent) => handlers?.onMessage(String(ev.data));
  ws.onclose = () => handlers?.onClose();
  ws.onerror = () => handlers?.onError();
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    setHandlers: (h) => {
      handlers = h;
    },
  };
};
