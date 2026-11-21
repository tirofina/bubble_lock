import { useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import keyringImage from './assets/privacy-bubble-keyring.png';
import { useLang } from './i18n.tsx';
import type { StoryServerAction, StorySessionSnapshot } from './story-session.ts';

type ManipulationMode = 'rotate' | 'move';
type KeyringAction = 'keyring-confirm' | 'keyring-panic';

interface Pose { readonly rotateX: number; readonly rotateY: number; readonly x: number; readonly y: number }
interface Gesture { readonly pointerId: number; readonly x: number; readonly y: number; readonly pose: Pose }

const initialPose: Pose = { rotateX: 8, rotateY: -10, x: 0, y: 0 };
const limits = { rotateX: 32, rotateY: 58, minX: -16, maxX: 72, minY: -32, maxY: 16 } as const;
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

export function VirtualKeyring({ snapshot, runAction, onActionStart, onVerified, onFailed, guidedAction = null }: {
  readonly snapshot: StorySessionSnapshot | null;
  readonly runAction: (action: StoryServerAction, idempotencyKey: string) => Promise<StorySessionSnapshot>;
  readonly onActionStart?: (action: KeyringAction) => void;
  readonly onVerified?: (action: KeyringAction, snapshot: StorySessionSnapshot) => void;
  readonly onFailed?: (action: KeyringAction) => void;
  readonly guidedAction?: KeyringAction | null;
}) {
  const { tr } = useLang();
  const [mode, setMode] = useState<ManipulationMode>('rotate');
  const [pose, setPose] = useState<Pose>(initialPose);
  const [active, setActive] = useState<KeyringAction | null>(null);
  const [verified, setVerified] = useState<KeyringAction | null>(null);
  const gesture = useRef<Gesture | null>(null);

  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, pose };
  };
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = gesture.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (mode === 'rotate') {
      setPose({ ...start.pose, rotateX: clamp(start.pose.rotateX - dy * 0.35, -limits.rotateX, limits.rotateX), rotateY: clamp(start.pose.rotateY + dx * 0.45, -limits.rotateY, limits.rotateY) });
    } else {
      setPose({ ...start.pose, x: clamp(start.pose.x + dx, limits.minX, limits.maxX), y: clamp(start.pose.y + dy, limits.minY, limits.maxY) });
    }
  };
  const pointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (gesture.current?.pointerId === event.pointerId) gesture.current = null;
  };

  const stageKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 12 : 6;
    setPose((current) => {
      if (mode === 'rotate') {
        const rotateY = event.key === 'ArrowLeft' ? current.rotateY - step : event.key === 'ArrowRight' ? current.rotateY + step : current.rotateY;
        const rotateX = event.key === 'ArrowUp' ? current.rotateX - step : event.key === 'ArrowDown' ? current.rotateX + step : current.rotateX;
        return { ...current, rotateX: clamp(rotateX, -limits.rotateX, limits.rotateX), rotateY: clamp(rotateY, -limits.rotateY, limits.rotateY) };
      }
      const x = event.key === 'ArrowLeft' ? current.x - step : event.key === 'ArrowRight' ? current.x + step : current.x;
      const y = event.key === 'ArrowUp' ? current.y - step : event.key === 'ArrowDown' ? current.y + step : current.y;
      return { ...current, x: clamp(x, limits.minX, limits.maxX), y: clamp(y, limits.minY, limits.maxY) };
    });
  };

  const press = async (action: KeyringAction) => {
    if (!snapshot || active) return;
    onActionStart?.(action);
    setActive(action);
    setVerified(null);
    const count = action === 'keyring-confirm' ? snapshot.keyring.confirmPresses + 1 : snapshot.keyring.panicPresses + 1;
    try {
      const next = await runAction(action, `${action}:${snapshot.browserSession.id}:${count}`);
      setVerified(action);
      onVerified?.(action, next);
    } catch {
      setVerified(null);
      onFailed?.(action);
    } finally {
      setActive(null);
    }
  };

  const latestKeyringAction = snapshot?.mobius.events.find((event) => event.action === 'keyring-confirm' || event.action === 'keyring-panic')?.action;
  const latchedAction = active ?? verified ?? (latestKeyringAction === 'keyring-confirm' || latestKeyringAction === 'keyring-panic' ? latestKeyringAction : null);
  const firmwareState = latchedAction === 'keyring-panic' ? 'panic' : latchedAction === 'keyring-confirm' ? 'confirm' : 'ready';
  const guidedComplete = guidedAction === null || verified === guidedAction
    || snapshot?.mobius.events.some((event) => event.action === guidedAction) === true;
  const guidance = guidedAction === 'keyring-panic'
    ? tr('주황색 비상 버튼을 눌러 도움 요청 흐름을 시연해 보세요.', 'Press the orange emergency button to try the help flow.')
    : tr('파란색 확인 버튼을 눌러 안전 신호를 남겨 보세요.', 'Press the blue confirm button to record a safe signal.');

  return <div className="virtual-keyring" aria-labelledby="virtual-keyring-title">
    <div className="virtual-keyring-head">
      <h3 id="virtual-keyring-title">{tr('키링', 'Keyring')}</h3>
      <div className="keyring-tools">
        <div className="keyring-mode" role="group" aria-label={tr('키링 조작 방식', 'Keyring handling')}>
          <button className={mode === 'rotate' ? 'active' : ''} aria-pressed={mode === 'rotate'} onClick={() => setMode('rotate')} type="button">{tr('회전', 'Rotate')}</button>
          <button className={mode === 'move' ? 'active' : ''} aria-pressed={mode === 'move'} onClick={() => setMode('move')} type="button">{tr('이동', 'Move')}</button>
        </div>
        <button className="keyring-reset" onClick={() => setPose(initialPose)} type="button">{tr('처음 자세', 'Reset')}</button>
      </div>
    </div>

    <div
      className={`keyring-stage mode-${mode}`}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerEnd}
      onPointerCancel={pointerEnd}
      onKeyDown={stageKeyDown}
      tabIndex={0}
      role="application"
      aria-roledescription={tr('키링 3D 보기', '3D keyring view')}
      aria-label={mode === 'rotate'
        ? tr('끌거나 방향키로 키링을 돌려요.', 'Drag or use the arrow keys to rotate the keyring.')
        : tr('끌거나 방향키로 키링을 옮겨요.', 'Drag or use the arrow keys to move the keyring.')}
    >
      <div className="keyring-model" style={{ transform: `translate3d(${pose.x}px, ${pose.y}px, 0) rotateX(${pose.rotateX}deg) rotateY(${pose.rotateY}deg)` }}>
        <span className="keyring-depth" aria-hidden="true" />
        <img src={keyringImage} alt={tr('확인 버튼과 비상 버튼이 있는 Privacy Bubble 키링', 'Privacy Bubble keyring with confirm and emergency buttons')} draggable={false} />
        <span className={`keyring-screen-live firmware-${firmwareState}`} data-firmware-screen={firmwareState} aria-live="polite">
          <i className="keyring-firmware-glyph" aria-hidden="true"><span /></i>
          <b>{firmwareState === 'panic' ? 'PANIC' : firmwareState === 'confirm' ? 'CONFIRM' : 'READY'}</b>
          <small>{firmwareState === 'panic' ? 'Emergency input' : firmwareState === 'confirm' ? 'Input received' : 'Press a button'}</small>
        </span>
        <button
          className={`keyring-physical-button confirm${active === 'keyring-confirm' ? ' pressed' : ''}${snapshot && guidedAction === 'keyring-confirm' && !guidedComplete ? ' is-guided' : ''}`}
          disabled={!snapshot || active !== null}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => void press('keyring-confirm')}
          type="button"
          title={tr('확인 버튼', 'Confirm button')}
          aria-label={tr('키링 확인 버튼 누르기', 'Press the keyring confirm button')}
        />
        <button
          className={`keyring-physical-button panic${active === 'keyring-panic' ? ' pressed' : ''}${snapshot && guidedAction === 'keyring-panic' && !guidedComplete ? ' is-guided' : ''}`}
          disabled={!snapshot || active !== null}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => void press('keyring-panic')}
          type="button"
          title={tr('비상 버튼', 'Emergency button')}
          aria-label={tr('키링 비상 버튼 누르기', 'Press the keyring emergency button')}
        />
      </div>
    </div>

    <div className="keyring-foot">
      <p className={`keyring-help${guidedAction && !guidedComplete ? ' is-guidance' : ''}`}>{guidedAction && !guidedComplete ? guidance : mode === 'rotate'
        ? tr('끌어서 돌려 보거나 버튼을 눌러 보세요.', 'Drag to turn it or try a button.')
        : tr('끌어서 위치를 옮겨 보세요.', 'Drag to move it around.')}</p>
      <p className="keyring-counters">
        <span><i className="confirm" aria-hidden="true" />{tr('확인', 'Confirm')} <b>{snapshot?.keyring.confirmPresses ?? 0}</b></span>
        <span><i className="panic" aria-hidden="true" />{tr('비상', 'Emergency')} <b>{snapshot?.keyring.panicPresses ?? 0}</b></span>
      </p>
    </div>
  </div>;
}
