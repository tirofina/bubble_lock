import { useCallback, useEffect, useState } from 'react';
import { getJson, ReadError } from './client.ts';
import { pick } from './server-messages.ts';
import { parseLocationSnapshot } from '../shared/location.ts';
import type { LocationSnapshot } from '../shared/location.ts';

export function useLocations(refresh: number, url = '/api/locations') {
  const [snapshot, setSnapshot] = useState<LocationSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [generation, setGeneration] = useState(0);
  const [now, setNow] = useState(Date.now());
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  useEffect(()=>{setSnapshot(null);setError(null);setLoading(true);},[url,refresh]);
  useEffect(()=>{
    if(!snapshot?.readExpiresAt)return;
    const timer=setTimeout(()=>{setSnapshot(null);setError(pick('위치 보기 권한을 다시 확인하고 있어요.', 'Checking the location permission again.'));},Math.max(0,Date.parse(snapshot.readExpiresAt)-Date.now()));
    return ()=>clearTimeout(timer);
  },[snapshot]);
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const { value } = await getJson(url, controller.signal);
        const next = parseLocationSnapshot(value);
        if (!disposed) { setSnapshot(next); setError(null); }
      } catch(cause) {
        if (!disposed) {
          const protectedFeed=url.startsWith('/api/portal/');
          const expired=cause instanceof ReadError&&[401,403].includes(cause.status??0);
          if(protectedFeed||expired)setSnapshot(null);
          setError(protectedFeed||expired?pick('위치를 보려면 위치 공유 권한이 필요해요. 공유 권한 화면에서 확인해 주세요.', 'A location sharing permission is needed to see location. Check the Sharing page.'):pick('위치 서버와 연결이 끊겼어요. 마지막으로 받은 위치와 시각을 보여 드려요.', 'Lost the connection to the location server. Showing the last location and time received.'));
        }
      } finally {
        if (!disposed) { setLoading(false); setNow(Date.now()); timer = setTimeout(() => void poll(), 4000); }
      }
    }
    void poll();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); };
  }, [refresh, generation, url]);
  return { snapshot, error, loading, now, reload };
}
