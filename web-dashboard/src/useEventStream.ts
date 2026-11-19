import { useCallback, useEffect, useRef, useState } from 'react';
import {
  initialTimelineState, timelineReducer, validateDashboardEvent,
} from '../shared/index.ts';
import type { DashboardEvent, TimelineState } from '../shared/index.ts';
import { errorMessage, getJson, isRecord, ReadError } from './client.ts';

type Connection = 'connecting' | 'connected' | 'offline' | 'disconnected' | 'invalid' | 'resync';
interface StreamView {
  readonly timeline: TimelineState;
  readonly events: readonly DashboardEvent[];
  readonly connection: Connection;
  readonly error: string | null;
}

const initialView: StreamView = {
  timeline: initialTimelineState, events: [], connection: 'connecting', error: null,
};

export function useEventStream() {
  const [view, setView] = useState<StreamView>(initialView);
  const current = useRef(initialView);
  const stream = useRef<EventSource | null>(null);
  const [generation, setGeneration] = useState(0);

  const publish = useCallback((next: StreamView) => {
    current.current = next;
    setView(next);
  }, []);

  const reconnect = useCallback((reset = false) => {
    stream.current?.close();
    publish(reset ? initialView : { ...current.current, connection: 'connecting', error: null });
    setGeneration((value) => value + 1);
  }, [publish]);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let source: EventSource | null = null;
    const offline = () => {
      source?.close();
      publish({ ...current.current, connection: 'offline', error: '인터넷 연결이 끊겼어요. 마지막으로 받은 기록을 보여 드려요.' });
    };
    const online = () => reconnect();
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);

    async function connect() {
      if (!navigator.onLine) { offline(); return; }
      publish({ ...current.current, connection: 'connecting', error: null });
      try {
        const { value } = await getJson('/api/source', controller.signal);
        if (disposed) return;
        if (!isRecord(value) || typeof value['simulation'] !== 'boolean' ||
          !Number.isSafeInteger(value['lastSequence']) || typeof value['lastSequence'] !== 'number') {
          throw new ReadError('기록 서버의 정보 형식이 예상과 달라요.');
        }
        if (current.current.timeline.lastSequence > value['lastSequence']) {
          publish({ ...current.current, connection: 'resync', error: '서버 기록이 새로 바뀌었어요. 처음부터 다시 받기를 눌러 주세요.' });
          return;
        }
        source = new EventSource(`/events?lastSequence=${current.current.timeline.lastSequence}`);
        stream.current = source;
        source.onopen = () => {
          if (!disposed) publish({ ...current.current, connection: 'connected', error: null });
        };
        source.onmessage = (message: MessageEvent<string>) => {
          if (disposed) return;
          const result = validateDashboardEvent(message.data);
          if (!result.valid) {
            source?.close();
            publish({ ...current.current, connection: 'invalid', error: `형식이 맞지 않는 기록을 받아서 수신을 멈췄어요. (${result.error})` });
            return;
          }
          const event = result.event;
          if (message.lastEventId !== String(event.sequence)) {
            source?.close();
            publish({ ...current.current, connection: 'invalid', error: '기록 번호가 맞지 않아 수신을 멈췄어요. 다시 연결해 주세요.' });
            return;
          }
          if (event.sequence > current.current.timeline.lastSequence + 1) {
            source?.close();
            publish({ ...current.current, connection: 'resync', error: '중간 기록이 빠졌어요. 다시 연결하거나 처음부터 다시 받아 주세요.' });
            return;
          }
          const duplicate = event.sequence <= current.current.timeline.lastSequence;
          publish({
            ...current.current,
            timeline: timelineReducer(current.current.timeline, event),
            events: duplicate ? current.current.events : [...current.current.events.slice(-99), event],
          });
        };
        source.onerror = () => {
          source?.close();
          if (!disposed) publish({
            ...current.current, connection: navigator.onLine ? 'disconnected' : 'offline',
            error: '실시간 연결이 끊겼어요. 받은 기록은 그대로 있어요. 새로고침하면 이어서 받아요.',
          });
        };
      } catch (error) {
        if (!disposed) publish({ ...current.current, connection: 'disconnected', error: errorMessage(error) });
      }
    }
    void connect();
    return () => {
      disposed = true;
      controller.abort();
      source?.close();
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
    };
  }, [generation, publish, reconnect]);

  return { ...view, reconnect };
}
