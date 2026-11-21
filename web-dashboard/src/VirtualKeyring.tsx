import { useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import keyringImage from './assets/privacy-bubble-keyring.png';
import { useLang } from './i18n.tsx';
import type { StoryServerAction, StorySessionSnapshot } from './story-session.ts';

type KeyringAction = 'keyring-confirm' | 'keyring-panic';

interface Pose { readonly rotateX: number; readonly rotateY: number }
interface Gesture { readonly pointerId: number; readonly x: number; readonly y: number; readonly pose: Pose }

const initialPose: Pose = { rotateX: 8, rotateY: -10 };
const limits = { rotateX: 32, rotateY: 58 } as const;
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
    setPose({
      rotateX: clamp(start.pose.rotateX - dy * 0.35, -limits.rotateX, limits.rotateX),
      rotateY: clamp(start.pose.rotateY + dx * 0.45, -limits.rotateY, limits.rotateY),
    });
  };

  const pointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (gesture.current?.pointerId === event.pointerId) gesture.current = null;
  };

  const stageKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 12 : 6;
    setPose((current) => {
      const rotateY = event.key === 'ArrowLeft' ? current.rotateY - step : event.key === 'ArrowRight' ? current.rotateY + step : current.rotateY;
      const rotateX = event.key === 'ArrowUp' ? current.rotateX - step : event.key === 'ArrowDown' ? current.rotateX + step : current.rotateX;
      return {
        rotateX: clamp(rotateX, -limits.rotateX, limits.rotateX),
        rotateY: clamp(rotateY, -limits.rotateY, limits.rotateY),
      };
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

  return <div className="virtual-keyring" aria-labelledby="virtual-keyring-title">
    <h3 className="story-sr" id="virtual-keyring-title">{tr('키링', 'Keyring')}</h3>
    <div
      className="keyring-stage"
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerEnd}
      onPointerCancel={pointerEnd}
      onKeyDown={stageKeyDown}
      tabIndex={0}
      role="application"
      aria-roledescription={tr('키링 3D 보기', '3D keyring view')}
      aria-label={tr('드래그나 방향키로 키링을 돌려요.', 'Drag or use the arrow keys to rotate the keyring.')}
    >
      <div className="keyring-model" style={{ transform: `rotateX(${pose.rotateX}deg) rotateY(${pose.rotateY}deg)` }}>
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
  </div>;
}
