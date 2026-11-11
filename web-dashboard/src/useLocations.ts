import { useCallback, useEffect, useState } from 'react';
import { getJson, ReadError } from './client.ts';
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
    const timer=setTimeout(()=>{setSnapshot(null);setError('위치 조회 승인을 갱신하고 있습니다.');},Math.max(0,Date.parse(snapshot.readExpiresAt)-Date.now()));
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
          setError(protectedFeed||expired?'현재 계정과 위치 공유 권한을 확인해 주세요.':'위치 피드 연결을 확인해 주세요. 마지막 수신 위치와 관측 시각을 표시합니다.');
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
