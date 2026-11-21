import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.tsx';
import { StoryMobiusTree } from './StoryMobiusTree.tsx';
import type { StoryScene } from './StoryDemo.tsx';
import type { StoryActionPhase, StorySessionSnapshot, StoryTrace } from './story-session.ts';

type PanelId = 'trace' | 'tree' | 'events' | 'scenes';
type KeyringAction = 'keyring-confirm' | 'keyring-panic';

interface FlowCopy {
  readonly title: string;
  readonly summary: string;
}

const flows: Record<StoryScene, FlowCopy> = {
  login: {
    title: 'A session for this browser only',
    summary: 'The BFF provisions a browser-isolated Mobius container, then retrieves it from the CSE.',
  },
  'activity-away': {
    title: 'Safe check from the keyring',
    summary: 'This session stores the away state and the verified keyring observation without location coordinates.',
  },
  'activity-home': {
    title: 'Home status verified',
    summary: 'The same session stores the home state, then retrieves the contentInstance from the CSE.',
  },
  'care-request': {
    title: 'Approval bound to a room and a deadline',
    summary: 'One grant binds three living-room resources to a server-enforced deadline.',
  },
  'caregiver-shared': {
    title: 'Three resources in one group request',
    summary: 'One request to the group fanOutPoint is distributed to all members, followed by member readback.',
  },
  'caregiver-ended': {
    title: 'The server enforces the deadline',
    summary: 'The server switches the group off, removes temporary access, and stores the expiry event.',
  },
  'check-in': {
    title: 'Reason first, location after approval',
    summary: 'The reason is stored first; a location lease opens for the approved five-minute interval.',
  },
};

const eventLabels: Readonly<Record<string, string>> = {
  SESSION_STARTED: 'Browser session provisioned',
  PRESENCE_CHANGED: 'Presence state stored',
  CARE_GRANT_APPROVED: 'Care grant approved',
  ROOM_GROUP_ON: 'Group fan-out switched resources on',
  ROOM_GROUP_OFF: 'Group fan-out switched resources off',
  GRANT_EXPIRED: 'Care grant expired',
  ROUTINE_ALERT: 'Check-in alert stored',
  CHECK_IN_CALL_STARTED: 'Check-in call requested',
  SHARE_DRAFT: 'Location-share draft stored',
  GUARDIAN_DECISION: 'Guardian decision stored',
  LOCATION_LEASE: 'Five-minute location lease created',
  LOCATION_LEASE_EXPIRED: 'Location lease expired',
  KEYRING_BUTTON_OBSERVATION: 'Keyring button observation stored',
  RESIDENT_CONFIRMED: 'Resident confirmation stored',
  PANIC_ALERT: 'Keyring emergency alert stored',
};

const sceneOrder: readonly StoryScene[] = ['login', 'activity-away', 'activity-home', 'care-request', 'caregiver-shared', 'caregiver-ended', 'check-in'];

const sceneLabels: Record<StoryScene, string> = {
  login: 'Start',
  'activity-away': 'Went out',
  'activity-home': 'Came home',
  'care-request': 'Care approval',
  'caregiver-shared': 'Room control',
  'caregiver-ended': 'Automatic end',
  'check-in': 'Check-in',
};

const panelLabels: Record<PanelId, string> = {
  trace: 'Transaction',
  tree: 'Resource tree',
  events: 'CSE records',
  scenes: 'Scenes',
};

const EVENTS_PER_PAGE = 1;

function readableType(type: string): string {
  const words = type.toLowerCase().split('_').filter(Boolean).join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function formatTime(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    ? new Date(parsed).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    : value;
}

function tracePath(path: string): { readonly parent: string; readonly resourceName: string } {
  const divider = path.lastIndexOf('/');
  return divider <= 0 ? { parent: '', resourceName: path } : { parent: path.slice(0, divider + 1), resourceName: path.slice(divider + 1) };
}

function eventTitle(event: StoryTrace | undefined, fallback: string): string {
  return event ? eventLabels[event.type] ?? readableType(event.type) : fallback;
}

function ResourcePath({ event, operation }: { readonly event: StoryTrace; readonly operation: 'CREATE' | 'RETRIEVE' }) {
  const path = tracePath(event.resource);
  const rsc = operation === 'CREATE' ? event.createRsc : event.retrieveRsc;
  return <code className="story-trace-path" data-trace-path={event.resource}>
    <span className="story-trace-parent">{path.parent}</span>
    <b className="story-trace-rn">{path.resourceName}</b>
    <span className="story-trace-rsc">{operation} RSC {rsc}</span>
  </code>;
}

export function StoryMobiusPanel({ scene, snapshot, phase, message, refresh, focusAction = null, focusAfterSequence = 0, freshPath = null }: {
  readonly scene: StoryScene;
  readonly snapshot: StorySessionSnapshot | null;
  readonly phase: StoryActionPhase;
  readonly message: string | null;
  readonly refresh?: () => Promise<StorySessionSnapshot | null>;
  readonly focusAction?: KeyringAction | null;
  readonly focusAfterSequence?: number;
  readonly freshPath?: string | null;
}) {
  const flow = flows[scene];
  const actual = snapshot?.mobius.actual === true;
  const allEvents = snapshot?.mobius.events ?? [];
  const events = allEvents.slice(0, 6);
  const actionEvents = focusAction
    ? allEvents.filter((event) => event.action === focusAction && event.sequence > focusAfterSequence).slice(0, 4)
    : events.slice(0, 1);
  const traceEvents = [...actionEvents].reverse();
  const newestTrace = actionEvents[0];
  const traceSending = focusAction ? traceEvents.length === 0 : phase === 'sending';
  const traceVerified = traceEvents.length > 0 && traceEvents.every((event) => event.verified);
  const verifiedCount = snapshot?.mobius.createRetrieveVerified ?? 0;
  const [mobilePanel, setMobilePanel] = useState<PanelId>('trace');
  const [eventPage, setEventPage] = useState(0);
  const [flashes, setFlashes] = useState<ReadonlySet<PanelId>>(new Set());
  const seenSequence = useRef<number | null>(null);
  const latestSequence = events[0]?.sequence ?? 0;
  const latestType = events[0]?.type ?? '';
  const eventPageCount = Math.max(1, Math.ceil(events.length / EVENTS_PER_PAGE));
  const visibleEvents = events.slice(eventPage * EVENTS_PER_PAGE, (eventPage + 1) * EVENTS_PER_PAGE);

  useEffect(() => {
    if (latestSequence === 0) return;
    if (seenSequence.current === null) {
      seenSequence.current = latestSequence;
      return;
    }
    if (latestSequence <= seenSequence.current) return;
    seenSequence.current = latestSequence;
    setFlashes(new Set<PanelId>(latestType ? ['trace', 'tree', 'events'] : ['trace', 'tree']));
    setMobilePanel('trace');
    setEventPage(0);
    const timer = window.setTimeout(() => setFlashes(new Set()), 3600);
    return () => window.clearTimeout(timer);
  }, [latestSequence, latestType]);

  useEffect(() => {
    setEventPage((current) => Math.min(current, eventPageCount - 1));
  }, [eventPageCount]);

  const choosePanel = (panel: PanelId) => {
    setMobilePanel(panel);
    setFlashes((current) => {
      const next = new Set(current);
      next.delete(panel);
      return next;
    });
  };
  const panelClass = (panel: PanelId, extra: string) => `story-panel-card story-mobile-panel ${extra}${mobilePanel === panel ? ' is-mobile-open' : ''}${flashes.has(panel) ? ' has-new-event' : ''}`;

  return <aside className="story-mobius" aria-labelledby="story-mobius-title" lang="en">
    <header className="story-mobius-head">
      <div>
        <h2 id="story-mobius-title">Mobius Resource Browser</h2>
        <p className="story-mobius-meta">{snapshot
          ? <>Session <code>{snapshot.browserSession.id}</code>, {snapshot.budget.actionsLeft} of {snapshot.budget.limit} actions available</>
          : 'Provisioning a browser-isolated session on the CSE.'}</p>
      </div>
      <span className={`badge ${actual ? 'success' : 'warning'}`}>{actual ? 'Live Mobius CSE' : 'Contract replay'}</span>
    </header>

    {message ? <p className="story-server-message" role="status">CSE transaction response received. Retry is available.</p> : null}

    <nav className="story-panel-tabs" aria-label="Mobius browser panels">
      {(Object.keys(panelLabels) as PanelId[]).map((panel) => <button
        key={panel}
        type="button"
        className={`${mobilePanel === panel ? 'active' : ''}${flashes.has(panel) ? ' has-new-event' : ''}`}
        aria-pressed={mobilePanel === panel}
        aria-controls={`story-panel-${panel}`}
        onClick={() => choosePanel(panel)}
      >{panelLabels[panel]}<span className="story-panel-alert" aria-hidden="true" /></button>)}
    </nav>

    <section id="story-panel-trace" className={panelClass('trace', 'story-trace')} data-phase={traceSending ? 'sending' : 'verified'} aria-labelledby="story-trace-title" aria-live="polite">
      <div className="story-trace-heading">
        <div>
          <p className="story-trace-eyebrow">Latest oneM2M transaction</p>
          <h2 className="story-trace-title" id="story-trace-title">{eventTitle(newestTrace, flow.title)}</h2>
        </div>
        {newestTrace ? <time className="story-trace-time" dateTime={newestTrace.at}>{formatTime(newestTrace.at)}</time> : null}
      </div>
      <ol className="story-trace-steps">
        <li className={`story-trace-step${traceSending ? ' is-active' : traceVerified ? ' is-done' : ''}`} data-step="request">
          <span className="story-trace-marker" aria-hidden="true">{traceVerified ? <Icon name="check" size={14} /> : '1'}</span>
          <div><strong>BFF request</strong><code>POST /api/story/action {focusAction ?? newestTrace?.action ?? ''}</code></div>
        </li>
        {traceEvents.length > 0 ? <li className={`story-trace-step${traceVerified ? ' is-done' : ' is-active'}`} data-step="create">
          <span className="story-trace-marker" aria-hidden="true">{traceVerified ? <Icon name="check" size={14} /> : '2'}</span>
          <div><strong>CREATE &lt;contentInstance&gt;</strong>{traceEvents.map((event) => <ResourcePath event={event} operation="CREATE" key={`create-${event.sequence}`} />)}</div>
        </li> : null}
        {traceVerified ? <li className="story-trace-step is-done" data-step="readback">
          <span className="story-trace-marker" aria-hidden="true"><Icon name="check" size={14} /></span>
          <div><strong>RETRIEVE &lt;contentInstance&gt;</strong>{traceEvents.map((event) => <ResourcePath event={event} operation="RETRIEVE" key={`read-${event.sequence}`} />)}</div>
        </li> : null}
      </ol>
      <p className="story-trace-summary">{flow.summary}</p>
    </section>

    <section id="story-panel-tree" className={panelClass('tree', 'story-mobius-tree-card')} aria-labelledby="story-tree-title">
      <div className="story-events-head">
        <h3 id="story-tree-title">oneM2M resource tree</h3>
        <span>{actual ? 'CSE readback' : 'Contract replay'}</span>
      </div>
      <StoryMobiusTree snapshot={snapshot} freshPath={freshPath} {...(refresh ? { onRefresh: refresh } : {})} />
    </section>

    <section id="story-panel-events" className={panelClass('events', 'story-mobius-events')} aria-labelledby="story-events-title">
      <div className="story-events-head">
        <h3 id="story-events-title">Verified CSE responses</h3>
        <span>{verifiedCount} total</span>
      </div>
      <div aria-live="polite">
        {events.length > 0 ? <ul>{visibleEvents.map((event, index) => <li
          className={event.resource === freshPath ? 'is-new-event is-fresh' : index === 0 && flashes.has('events') ? 'is-new-event' : ''}
          key={`${event.sequence}-${event.type}`}
          data-event-type={event.type}
          data-path={event.resource}
        >
          <span className="story-event-check" aria-hidden="true"><Icon name="check" size={14} /></span>
          <div>
            <strong>{eventLabels[event.type] ?? readableType(event.type)}</strong>
            <small>{formatTime(event.at)}, CREATE RSC {event.createRsc}, RETRIEVE RSC {event.retrieveRsc}</small>
            <code>{event.resource}</code>
          </div>
        </li>)}</ul> : <p className="story-server-wait">Waiting for the first CSE response.</p>}
      </div>
      {events.length > EVENTS_PER_PAGE ? <div className="story-events-pager" aria-label="CSE record pages">
        <button type="button" onClick={() => setEventPage((current) => Math.max(0, current - 1))} disabled={eventPage === 0} aria-label="Previous CSE record page">‹</button>
        <span>{eventPage + 1} / {eventPageCount}</span>
        <button type="button" onClick={() => setEventPage((current) => Math.min(eventPageCount - 1, current + 1))} disabled={eventPage >= eventPageCount - 1} aria-label="Next CSE record page">›</button>
      </div> : null}
      <p className="story-mobius-root"><span>CSE-ID {snapshot?.mobius.cse ?? 'Mobius4'}</span><code>{snapshot?.mobius.root ?? '/Mobius/story-demo/session'}</code></p>
    </section>

    <section id="story-panel-scenes" className={panelClass('scenes', 'story-scene-panel')} aria-labelledby="story-scenes-title">
      <h3 id="story-scenes-title">Story scenes</h3>
      <nav aria-label="Story scenes"><ol>{sceneOrder.map((item, index) => <li key={item}>
        <a className={item === scene ? 'active' : ''} aria-current={item === scene ? 'page' : undefined} href={`#/story/${item}`}>
          <span>{index + 1}</span>{sceneLabels[item]}
        </a>
      </li>)}</ol></nav>
      <a className="story-mobile-dashboard-link" href="#/user/overview">Family dashboard<Icon name="arrow" size={17} /></a>
    </section>
  </aside>;
}
