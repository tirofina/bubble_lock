import { useEffect, useState } from 'react';
import { Badge, Timestamp } from './ui.tsx';
import { getJson, isRecord } from './client.ts';
import { useLang } from './i18n.tsx';

interface AgentRun {
  kind: 'delegation' | 'triage'; title: string; runId: string; status: string; at: string; agent: string; invocations: number | null; interruption?: string | null;
  action?: string | null; severity?: string | null; toolsByServer: Record<string, string[]>; rejectedProbes: string[]; approvalChecks?: string[];
  draftHash: string | null; approvalHash: string | null; decision?: string | null; evidenceHash?: string | null; lease?: string | null; receipt: { path: string; sha256: string };
}

/** Korean names for the run titles the server sends in English. */
const titlesKo: Record<string, string> = {
  'Visitor location delegation (R17 afternoon care)': '방문자 위치 위임 (R17 오후 돌봄)',
  'Anomaly triage, Claude run 3 (C4 trail fork)': '이상 징후 분류, Claude 실행 3 (C4 trail fork)',
  'Anomaly triage, scripted policy (C4 trail fork)': '이상 징후 분류, 규칙 정책 (C4 trail fork)',
};

/** Operator audit: MCP agent runs from the receipts (replayed), tools per MCP server and the approval hashes. */
export function AgentRuns() {
  const { lang, tr } = useLang();
  const [generation, setGeneration] = useState(0);
  const [runs, setRuns] = useState<AgentRun[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    void getJson('/api/agent-runs', controller.signal).then(({ value }) => { if (isRecord(value) && Array.isArray(value['runs'])) setRuns(value['runs'] as AgentRun[]); else setError(true); }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [generation]);
  return <div className="content-card stack agent-runs">
    <div className="card-heading"><div><h2>{tr('MCP 에이전트 실행 기록', 'MCP agent runs')}</h2><p>{tr('실행마다 MCP 서버별로 부른 도구와 보호자 승인 hash예요.', 'Tools called per MCP server and the guardian approval hash for each run.')}</p></div><Badge tone="warning">{tr('기록 재생', 'Replayed')}</Badge></div>
    {error && <p className="notice error" role="alert">{tr('실행 기록을 불러오지 못했어요.', 'The run records could not be loaded.')} <button type="button" onClick={() => setGeneration((value) => value + 1)}>{tr('다시 시도', 'Try again')}</button></p>}
    {runs === null && !error && <p role="status">{tr('실행 기록을 불러오고 있어요…', 'Loading run records…')}</p>}
    {runs?.map((run) => <article className="triage-run" key={`${run.receipt.path}-${run.runId}`}>
      <div className="row"><div className="stack-tight"><strong>{lang === 'ko' ? titlesKo[run.title] ?? run.title : run.title}</strong><span className="small muted mono">{run.runId}</span>
        <span className="small muted">{run.agent === 'scripted triage policy (0 LLM calls)' ? tr('규칙 기반 분류 정책 (LLM 호출 0회)', run.agent) : run.agent}{run.invocations ? tr(`, 호출 ${run.invocations}회`, `, ${run.invocations} invocations`) : ''}{run.action ? `, ${run.action} (${run.severity})` : ''}</span></div>
        <Badge tone={run.status === 'COMPLETED' || run.status === 'PASS' ? 'success' : 'warning'}>{run.status}</Badge></div>
      {run.interruption && <p className="small muted">{tr('중단과 재개', 'Interruption and resume')}: {run.interruption}</p>}
      <dl className="triage-tools">{Object.entries(run.toolsByServer).map(([server, tools]) => <div key={server}><dt>{server}</dt><dd>{tools.length ? tools.map((tool) => <code key={tool}>{tool}</code>) : <span className="muted">{tr('호출 없음', 'not called')}</span>}</dd></div>)}</dl>
      <dl className="triage-hashes">
        {run.draftHash && <div><dt>{tr('초안 hash', 'Draft hash')}</dt><dd><code>{run.draftHash}</code></dd></div>}
        <div><dt>{tr('승인 hash (approvalHash)', 'Approval hash')}</dt><dd>{run.approvalHash ? <code>{run.approvalHash}</code> : <span className="muted">{run.approvalChecks?.length ? run.approvalChecks.join(', ') : tr('승인 단계 없음 (checkIn)', 'no approval step (checkIn)')}</span>}</dd></div>
        {run.evidenceHash && <div><dt>{tr('실행 증거 hash', 'Evidence hash')}</dt><dd><code>{run.evidenceHash}</code></dd></div>}
        {run.rejectedProbes.length > 0 && <div><dt>{tr('거절된 시도', 'Rejected probes')}</dt><dd>{run.rejectedProbes.join(', ')}</dd></div>}
        {run.lease && <div><dt>{tr('적용된 lease', 'Applied lease')}</dt><dd>{run.lease}</dd></div>}
      </dl>
      <p className="caption muted">{run.receipt.path}, <Timestamp at={run.at} />, sha256 <code>{run.receipt.sha256.slice(0, 16)}</code></p>
    </article>)}
  </div>;
}
