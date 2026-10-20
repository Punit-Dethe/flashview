import { useEffect, useRef, useState, type CSSProperties } from 'react';

export function HomeWordmark() {
  const wordmark = useRef<HTMLParagraphElement>(null);
  const [animating, setAnimating] = useState(false);

  useEffect(() => {
    const element = wordmark.current;
    if (!element) return;
    let visible = false;
    const update = () => setAnimating(visible && document.visibilityState === 'visible');
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      update();
    });
    observer.observe(element);
    document.addEventListener('visibilitychange', update);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  return (
    <p ref={wordmark} className={'home-wordmark' + (animating ? ' is-animating' : '')} role="img" aria-label="WarpView">
      {'warpview'.split('').map((letter, index) => (
        <span key={index} aria-hidden="true" style={{ '--letter': index } as CSSProperties}>{letter}</span>
      ))}
    </p>
  );
}
