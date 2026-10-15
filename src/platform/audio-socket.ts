// Supports: SPEC-VOX-002, SPEC-PER-022 (binary audio, bounded queues, proxy and verified TLS).
import { rootCertificates } from "node:tls";
import { proxyFor, type NetworkSettings } from "./network";
export interface AudioSocketPeer {
  send(data: string | Uint8Array): void;
  close(): void;
}
export interface AudioSocketHandlers {
  open(peer: AudioSocketPeer): void;
  message(text: string): void;
  closed(): void;
}
export type AudioSocketConnect = (
  url: string,
  headers: Record<string, string>,
  handlers: AudioSocketHandlers,
) => { close(): void };
export function audioSocketConnector(
  settings: NetworkSettings,
): AudioSocketConnect {
  return (url, headers, handlers) => {
    const proxy = proxyFor(new URL(url), settings),
      ca = settings.extraCa
        ? [...rootCertificates, settings.extraCa]
        : undefined;
    const socket = new WebSocket(url, {
      headers,
      ...(proxy ? { proxy } : {}),
      ...(ca || settings.clientCert
        ? {
            tls: {
              ...(ca ? { ca } : {}),
              ...(settings.clientCert
                ? { cert: settings.clientCert, key: settings.clientKey }
                : {}),
            },
          }
        : {}),
    });
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      handlers.closed();
    };
    const close = () => {
      socket.close(1000);
      end();
    };
    socket.onopen = () => {
      if (ended) {
        socket.close();
        return;
      }
      handlers.open({
        send: (data) => {
          if (
            ended ||
            socket.readyState !== WebSocket.OPEN ||
            socket.bufferedAmount > 262144
          )
            throw Error("Audio connection is not writable.");
          socket.send(data);
        },
        close,
      });
    };
    socket.onmessage = (event) => {
      if (ended) return;
      if (typeof event.data !== "string" || event.data.length > 32768) {
        close();
        return;
      }
      handlers.message(event.data);
    };
    socket.onerror = () => {
      socket.close();
      end();
    };
    socket.onclose = end;
    return { close };
  };
}
