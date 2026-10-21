import { useEffect, useRef, type RefObject } from 'react';

/** Native vertical scrolling/pinch and zoomed panning retain their gestures. */
export function useSwipeNavigation(target: RefObject<HTMLElement | null>, enabled: boolean,
  previous: () => void, next: () => void, ownTouchGestures = false) {
  const actions = useRef({ previous, next });
  useEffect(() => { actions.current = { previous, next }; }, [previous, next]);
  useEffect(() => {
    const element = target.current;
    if (!element || !enabled) return;
    let start: { x: number; y: number; time: number } | null = null;
    const cancel = () => { start = null; };
    const begin = (event: TouchEvent) => {
      if (event.touches.length !== 1 || (event.target instanceof Element &&
          event.target.closest('button,input,textarea,select,a,nav,[contenteditable="true"]'))) {
        cancel(); return;
      }
      const touch = event.touches[0];
      start = { x: touch.clientX, y: touch.clientY, time: performance.now() };
      if (ownTouchGestures) event.stopPropagation();
    };
    const move = (event: TouchEvent) => {
      if (event.touches.length !== 1) cancel();
      else if (start && ownTouchGestures) event.stopPropagation();
    };
    const end = (event: TouchEvent) => {
      const initial = start;
      cancel();
      if (initial && ownTouchGestures) event.stopPropagation();
      if (!initial || event.touches.length || event.changedTouches.length !== 1) return;
      const touch = event.changedTouches[0];
      const dx = touch.clientX - initial.x, dy = touch.clientY - initial.y;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5 ||
          performance.now() - initial.time > 800) return;
      if (dx < 0) actions.current.next(); else actions.current.previous();
    };
    // Observe before an embedded renderer consumes events inside its canvas.
    element.addEventListener('touchstart', begin, { passive: true, capture: true });
    element.addEventListener('touchmove', move, { passive: true, capture: true });
    element.addEventListener('touchend', end, { passive: true, capture: true });
    element.addEventListener('touchcancel', cancel, { passive: true, capture: true });
    return () => {
      element.removeEventListener('touchstart', begin, true);
      element.removeEventListener('touchmove', move, true);
      element.removeEventListener('touchend', end, true);
      element.removeEventListener('touchcancel', cancel, true);
    };
  }, [target, enabled, ownTouchGestures]);
}
