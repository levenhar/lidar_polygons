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

    // If bubble width is 0 or invalid, try again on next frame
    if (bubbleRect.width === 0) {
      requestAnimationFrame(() => recompute());
      return;
    }

    const pad = 8; // viewport padding in px

    // Center bubble above the trigger
    const desiredLeftViewport = wrapRect.left + wrapRect.width / 2 - bubbleRect.width / 2;

    // Check if tooltip would go off the right edge of the screen
    const wouldOverflowRight = desiredLeftViewport + bubbleRect.width > vw - pad;
    
    let clampedLeftViewport: number;
    let useFixedPosition = false;
    
    if (wouldOverflowRight) {
      // If it would overflow, position at the start of the window with padding
      clampedLeftViewport = pad;
      useFixedPosition = true;
    } else {
      // Otherwise, clamp to ensure it doesn't go off the left edge either
      const minLeftViewport = pad;
      const maxLeftViewport = Math.max(pad, vw - pad - bubbleRect.width);
      clampedLeftViewport = clamp(desiredLeftViewport, minLeftViewport, maxLeftViewport);
    }

    if (useFixedPosition) {
      // Use fixed positioning to align with window start
      const top = wrapRect.top - bubbleRect.height - 10; // 10px gap above
      bubble.style.position = 'fixed';
      bubble.style.left = `${clampedLeftViewport}px`;
      bubble.style.top = `${top}px`;
      bubble.style.right = 'auto';
      bubble.style.bottom = 'auto';
      bubble.style.transform = 'translateY(0)';
      bubble.style.insetInlineStart = 'auto';
      bubble.style.insetInlineEnd = 'auto';
      // Clear the CSS variable that might interfere
      wrap.style.setProperty('--tt-left', 'auto');
      
      // Arrow positioning - point towards trigger center
      // Calculate where the button center is relative to the bubble's left edge
      const triggerCenterViewport = wrapRect.left + wrapRect.width / 2;
      const arrowLeftWithinBubble = triggerCenterViewport - clampedLeftViewport;
      const arrowPad = 10;
      // Clamp arrow to stay within bubble bounds, but prioritize pointing to button center
      const clampedArrow = clamp(arrowLeftWithinBubble, arrowPad, Math.max(arrowPad, bubbleRect.width - arrowPad));
      // Set arrow position on both wrap and bubble to ensure it works with fixed positioning
      wrap.style.setProperty('--tt-arrow-left', `${clampedArrow}px`);
      bubble.style.setProperty('--tt-arrow-left', `${clampedArrow}px`);
    } else {
      // Use normal absolute positioning relative to wrap
      bubble.style.position = '';
      bubble.style.left = '';
      bubble.style.top = '';
      bubble.style.right = '';
      bubble.style.bottom = '';
      bubble.style.transform = '';
      bubble.style.insetInlineStart = '';
      bubble.style.insetInlineEnd = '';
      
      const leftWithinWrap = clampedLeftViewport - wrapRect.left;
      wrap.style.setProperty('--tt-left', `${leftWithinWrap}px`);

      // Arrow wants to point at the trigger center; keep it within bubble bounds.
      const triggerCenterViewport = wrapRect.left + wrapRect.width / 2;
      const arrowLeftWithinBubble = triggerCenterViewport - clampedLeftViewport;
      const arrowPad = 10;
      const clampedArrow = clamp(arrowLeftWithinBubble, arrowPad, Math.max(arrowPad, bubbleRect.width - arrowPad));
      wrap.style.setProperty('--tt-arrow-left', `${clampedArrow}px`);
    }
  }, []);

  useLayoutEffect(() => {
    if (!open) return;

    // Measure after styles apply - use double RAF to ensure tooltip is fully rendered and measured
    let rafId1: number;
    let rafId2: number;
    
    rafId1 = requestAnimationFrame(() => {
      rafId2 = requestAnimationFrame(() => recompute());
    });

    const onResize = () => recompute();
    const onScroll = () => recompute();

    window.addEventListener('resize', onResize);
    // capture=true so we also catch scrolls on nested containers
    window.addEventListener('scroll', onScroll, true);

    return () => {
      if (rafId1) cancelAnimationFrame(rafId1);
      if (rafId2) cancelAnimationFrame(rafId2);
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


