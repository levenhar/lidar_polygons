import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';

type TooltipProps = {
  tooltip: string;
  children: React.ReactNode;
  className?: string;
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

const Tooltip: React.FC<TooltipProps> = ({ tooltip, children, className }) => {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);

  const recompute = useCallback(() => {
    const wrap = wrapRef.current;
    const bubble = bubbleRef.current;
    if (!wrap || !bubble) return;

    const wrapRect = wrap.getBoundingClientRect();
    const bubbleRect = bubble.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;

    // Desired: center bubble above the trigger
    const desiredLeftViewport = wrapRect.left + wrapRect.width / 2 - bubbleRect.width / 2;

    const pad = 8; // viewport padding in px
    const minLeftViewport = pad;
    const maxLeftViewport = Math.max(pad, vw - pad - bubbleRect.width);
    const clampedLeftViewport = clamp(desiredLeftViewport, minLeftViewport, maxLeftViewport);

    const leftWithinWrap = clampedLeftViewport - wrapRect.left;
    wrap.style.setProperty('--tt-left', `${leftWithinWrap}px`);

    // Arrow wants to point at the trigger center; keep it within bubble bounds.
    const triggerCenterViewport = wrapRect.left + wrapRect.width / 2;
    const arrowLeftWithinBubble = triggerCenterViewport - clampedLeftViewport;
    const arrowPad = 10;
    const clampedArrow = clamp(arrowLeftWithinBubble, arrowPad, Math.max(arrowPad, bubbleRect.width - arrowPad));
    wrap.style.setProperty('--tt-arrow-left', `${clampedArrow}px`);
  }, []);

  useLayoutEffect(() => {
    if (!open) return;

    // Measure after styles apply
    const raf = requestAnimationFrame(() => recompute());

    const onResize = () => recompute();
    const onScroll = () => recompute();

    window.addEventListener('resize', onResize);
    // capture=true so we also catch scrolls on nested containers
    window.addEventListener('scroll', onScroll, true);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true as any);
    };
  }, [open, recompute]);

  return (
    <span
      ref={wrapRef}
      className={`tooltip-wrap${className ? ` ${className}` : ''}`}
      data-open={open ? 'true' : 'false'}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={() => setOpen(false)}
    >
      {children}
      <span ref={bubbleRef} className="tooltip-bubble" role="tooltip">
        {tooltip}
      </span>
    </span>
  );
};

export default Tooltip;


