import { useCallback, useEffect, useRef, useState } from 'react';
import type { DevicePressKey, ScreenTapPoint } from './controlCenterClient';

export interface ScreenGestureHandlers {
  onTap?: (point: ScreenTapPoint) => void;
  onSwipe?: (from: ScreenTapPoint, to: ScreenTapPoint) => void;
  onLongPress?: (point: ScreenTapPoint) => void;
  onScroll?: (point: ScreenTapPoint, deltaX: number, deltaY: number) => void;
  onInputText?: (text: string) => void;
  onPressKey?: (key: DevicePressKey) => void;
}

const LONG_PRESS_MS = 550;
const SWIPE_MIN_DISTANCE = 0.035;
const WHEEL_THROTTLE_MS = 48;

type GesturePhase = 'idle' | 'pending' | 'long-press-fired' | 'swiping';

const PRESS_KEYS = new Set<DevicePressKey>([
  'Enter', 'Backspace', 'Delete', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);

export interface DeviceScreenGestureOptions {
  keyboardEnabled?: boolean;
  onActivate?: () => void;
}

/** Returns true when the event was handled as device input. */
export function handleDeviceScreenKeyDown(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>,
  handlers: Pick<ScreenGestureHandlers, 'onInputText' | 'onPressKey'>,
): boolean {
  if (event.key === 'Escape') return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (PRESS_KEYS.has(event.key as DevicePressKey)) {
    handlers.onPressKey?.(event.key as DevicePressKey);
    return true;
  }
  if (event.key.length === 1) {
    handlers.onInputText?.(event.key);
    return true;
  }
  return false;
}

/** scrcpy-style pointer gestures plus wheel scroll and keyboard forwarding. */
export function useDeviceScreenGestures(
  enabled: boolean,
  projectPoint: (clientX: number, clientY: number) => ScreenTapPoint | null,
  handlers: ScreenGestureHandlers,
  options: DeviceScreenGestureOptions = {},
) {
  const keyboardEnabled = options.keyboardEnabled ?? enabled;
  const phaseRef = useRef<GesturePhase>('idle');
  const startRef = useRef<ScreenTapPoint | null>(null);
  const latestRef = useRef<ScreenTapPoint | null>(null);
  const timerRef = useRef<number | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewportNode, setViewportNode] = useState<HTMLDivElement | null>(null);
  const lastWheelAtRef = useRef(0);

  const bindViewportRef = useCallback((node: HTMLDivElement | null) => {
    viewportRef.current = node;
    setViewportNode(node);
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    clearTimer();
    phaseRef.current = 'idle';
    startRef.current = null;
    latestRef.current = null;
    pointerIdRef.current = null;
  }, [clearTimer]);

  const resolvePoint = useCallback((clientX: number, clientY: number): ScreenTapPoint | null => {
    return projectPoint(clientX, clientY)
      ?? (viewportRef.current ? projectViewportPoint(viewportRef.current, clientX, clientY) : null);
  }, [projectPoint]);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (!enabled || event.button !== 0) return;
    const start = resolvePoint(event.clientX, event.clientY);
    if (!start) return;
    event.preventDefault();
    event.stopPropagation();
    options.onActivate?.();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerIdRef.current = event.pointerId;
    startRef.current = start;
    latestRef.current = start;
    phaseRef.current = 'pending';
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      if (phaseRef.current !== 'pending' || !startRef.current) return;
      phaseRef.current = 'long-press-fired';
      handlers.onLongPress?.(startRef.current);
    }, LONG_PRESS_MS);
  }, [clearTimer, enabled, handlers, options.onActivate, resolvePoint]);

  const stopClickPropagation = useCallback((event: React.MouseEvent<HTMLElement>) => {
    event.stopPropagation();
  }, []);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (!enabled || pointerIdRef.current !== event.pointerId || phaseRef.current === 'idle') return;
    const next = resolvePoint(event.clientX, event.clientY);
    if (!next || !startRef.current) return;
    latestRef.current = next;
    const dx = next.x - startRef.current.x;
    const dy = next.y - startRef.current.y;
    if (Math.hypot(dx, dy) >= SWIPE_MIN_DISTANCE * 0.6) {
      phaseRef.current = 'swiping';
      clearTimer();
    }
  }, [clearTimer, enabled, resolvePoint]);

  const finishPointer = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (!enabled || pointerIdRef.current !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    finishPointer(event);
    const start = startRef.current;
    const end = latestRef.current ?? resolvePoint(event.clientX, event.clientY);
    const phase = phaseRef.current;
    reset();
    if (!start || !end) return;
    if (phase === 'long-press-fired') return;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const distance = Math.hypot(dx, dy);
    if (distance >= SWIPE_MIN_DISTANCE) {
      handlers.onSwipe?.(start, end);
      return;
    }
    handlers.onTap?.(start);
  }, [enabled, finishPointer, handlers, resolvePoint, reset]);

  const onPointerCancel = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (pointerIdRef.current !== event.pointerId) return;
    finishPointer(event);
    reset();
  }, [finishPointer, reset]);

  useEffect(() => {
    const element = viewportNode;
    if (!enabled || !element || !handlers.onScroll) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.deltaX && !event.deltaY) return;
      const now = Date.now();
      if (now - lastWheelAtRef.current < WHEEL_THROTTLE_MS) return;
      lastWheelAtRef.current = now;
      const point = resolvePoint(event.clientX, event.clientY)
        ?? (element ? projectViewportPoint(element, event.clientX, event.clientY) : null);
      if (!point) return;
      event.preventDefault();
      event.stopPropagation();
      handlers.onScroll?.(point, event.deltaX, event.deltaY);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [enabled, handlers, resolvePoint, viewportNode]);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (!keyboardEnabled) return;
    if (handleDeviceScreenKeyDown(event, handlers)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, [handlers, keyboardEnabled]);

  const keyboardProps = keyboardEnabled
    ? {
      tabIndex: 0 as const,
      role: 'button' as const,
      'aria-label': 'Device screen control surface',
      onKeyDown,
    }
    : {};

  return enabled
    ? {
      viewportRef: bindViewportRef,
      ...keyboardProps,
      onClick: stopClickPropagation,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
    }
    : { viewportRef: bindViewportRef };
}

export function swipeDurationMs(from: ScreenTapPoint, to: ScreenTapPoint): number {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  return Math.min(900, Math.max(180, Math.round(180 + distance * 700)));
}

/** Convert wheel delta at a screen point into a short scroll swipe (scrcpy-style). */
export function scrollSwipeEndpoints(
  point: ScreenTapPoint,
  deltaX: number,
  deltaY: number,
): { from: ScreenTapPoint; to: ScreenTapPoint } {
  const dominant = Math.abs(deltaX) > Math.abs(deltaY);
  const magnitude = Math.min(0.32, Math.max(0.07, (Math.abs(dominant ? deltaX : deltaY) / 120) * 0.11));
  if (dominant) {
    const dx = Math.sign(deltaX) * magnitude;
    return { from: point, to: { x: clamp01(point.x + dx), y: point.y } };
  }
  const dy = Math.sign(-deltaY) * magnitude;
  return { from: point, to: { x: point.x, y: clamp01(point.y + dy) } };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function projectViewportPoint(element: HTMLElement, clientX: number, clientY: number): ScreenTapPoint | null {
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const localX = clientX - rect.left;
  const localY = clientY - rect.top;
  if (localX < 0 || localY < 0 || localX > rect.width || localY > rect.height) return null;
  return { x: clamp01(localX / rect.width), y: clamp01(localY / rect.height) };
}
