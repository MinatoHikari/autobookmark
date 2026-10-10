import { browser } from 'wxt/browser';

/**
 * runtime.connect 端口流式协议（TL;DR 等逐 token 输出场景）。
 * @webext-core/messaging 不支持流式，这里用一个极小的自定义端口协议。
 */
export const STREAM_PORT = 'autobookmark-stream';

export type StreamTask = 'tldr';

export interface StreamRequest {
  task: StreamTask;
  payload: unknown;
}

export type StreamEvent =
  | { type: 'start' }
  | { type: 'delta'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

export interface StreamHandlers {
  onStart?: () => void;
  onDelta: (text: string) => void;
  onDone?: () => void;
  onError: (message: string) => void;
}

/** UI 侧：发起流式任务 */
export function startStream(task: StreamTask, payload: unknown, handlers: StreamHandlers) {
  const port = browser.runtime.connect({ name: STREAM_PORT });
  port.postMessage({ task, payload } satisfies StreamRequest);
  port.onMessage.addListener((event: StreamEvent) => {
    switch (event.type) {
      case 'start':
        handlers.onStart?.();
        break;
      case 'delta':
        handlers.onDelta(event.text);
        break;
      case 'done':
        handlers.onDone?.();
        port.disconnect();
        break;
      case 'error':
        handlers.onError(event.message);
        port.disconnect();
        break;
    }
  });
}
