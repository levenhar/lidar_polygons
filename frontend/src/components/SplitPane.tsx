import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import './SplitPane.css';

export interface SplitPaneProps {
  /** Direction of split: 'horizontal' (side-by-side) or 'vertical' (stacked) */
  direction?: 'horizontal' | 'vertical';
  /** Initial split ratio (0-1), where 0.5 means 50/50 split */
  initialRatio?: number;
  /** Minimum size for first pane (in pixels or percentage) */
  minSizeFirst?: number | string;
  /** Minimum size for second pane (in pixels or percentage) */
  minSizeSecond?: number | string;
  /** Callback when ratio changes */
  onRatioChange?: (ratio: number) => void;
  /** Storage key for persisting ratio (if not provided, ratio is not persisted) */
  storageKey?: string;
  /** First pane content */
  children: [React.ReactNode, React.ReactNode];
  /** Optional className for container */
  className?: string;
}

const DEFAULT_RATIO = 0.5;
const STORAGE_PREFIX = 'splitPaneRatio:';

/**
 * SplitPane component that allows resizing two panes by dragging a divider.
 * Supports both horizontal (side-by-side) and vertical (stacked) layouts.
 * Persists ratio to localStorage if storageKey is provided.
 */
const SplitPane: React.FC<SplitPaneProps> = ({
  direction = 'horizontal',
  initialRatio,
  minSizeFirst,
  minSizeSecond,
  onRatioChange,
  storageKey,
  children,
  className = ''
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const dividerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [ratio, setRatio] = useState<number>(() => {
    // Try to load from localStorage first, then use initialRatio, then default
    if (storageKey) {
      try {
        const stored = localStorage.getItem(`${STORAGE_PREFIX}${storageKey}`);
        if (stored !== null) {
          const parsed = parseFloat(stored);
          if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) {
            return parsed;
          }
        }
      } catch (error) {
        console.warn('Failed to load split ratio from localStorage:', error);
      }
    }
    return initialRatio ?? DEFAULT_RATIO;
  });

  // Parse min sizes
  const minSizeFirstPx = useMemo(() => {
    if (!minSizeFirst) return 0;
    if (typeof minSizeFirst === 'number') return minSizeFirst;
    // Parse percentage or pixel string
    if (minSizeFirst.endsWith('%')) {
      return null; // Will be calculated as percentage
    }
    if (minSizeFirst.endsWith('px')) {
      return parseFloat(minSizeFirst);
    }
    return parseFloat(minSizeFirst) || 0;
  }, [minSizeFirst]);

  const minSizeSecondPx = useMemo(() => {
    if (!minSizeSecond) return 0;
    if (typeof minSizeSecond === 'number') return minSizeSecond;
    if (minSizeSecond.endsWith('%')) {
      return null; // Will be calculated as percentage
    }
    if (minSizeSecond.endsWith('px')) {
      return parseFloat(minSizeSecond);
    }
    return parseFloat(minSizeSecond) || 0;
  }, [minSizeSecond]);

  const minSizeFirstPercent = useMemo(() => {
    if (!minSizeFirst) return 0;
    if (typeof minSizeFirst === 'string' && minSizeFirst.endsWith('%')) {
      return parseFloat(minSizeFirst) / 100;
    }
    return null;
  }, [minSizeFirst]);

  const minSizeSecondPercent = useMemo(() => {
    if (!minSizeSecond) return 0;
    if (typeof minSizeSecond === 'string' && minSizeSecond.endsWith('%')) {
      return parseFloat(minSizeSecond) / 100;
    }
    return null;
  }, [minSizeSecond]);

  // Clamp ratio based on min sizes
  const clampRatio = useCallback((newRatio: number, containerSize: number): number => {
    let minRatio = 0;
    let maxRatio = 1;

    // Calculate min ratio based on first pane min size
    if (minSizeFirstPx !== null && minSizeFirstPx > 0) {
      minRatio = Math.max(minRatio, minSizeFirstPx / containerSize);
    }
    if (minSizeFirstPercent !== null) {
      minRatio = Math.max(minRatio, minSizeFirstPercent);
    }

    // Calculate max ratio based on second pane min size
    if (minSizeSecondPx !== null && minSizeSecondPx > 0) {
      maxRatio = Math.min(maxRatio, 1 - (minSizeSecondPx / containerSize));
    }
    if (minSizeSecondPercent !== null) {
      maxRatio = Math.min(maxRatio, 1 - minSizeSecondPercent);
    }

    return Math.max(minRatio, Math.min(maxRatio, newRatio));
  }, [minSizeFirstPx, minSizeFirstPercent, minSizeSecondPx, minSizeSecondPercent]);

  // Handle drag start
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
    
    // Capture pointer to prevent map/graph interactions
    if (dividerRef.current) {
      dividerRef.current.setPointerCapture?.(e.pointerId ?? 0);
    }
  }, []);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  // Handle drag
  const handleMouseMove = useCallback((e: MouseEvent | TouchEvent) => {
    if (!isDragging) return;
    if (!containerRef.current) return;

    const containerRect = containerRef.current.getBoundingClientRect();
    const isHorizontal = direction === 'horizontal';
    const containerSize = isHorizontal ? containerRect.width : containerRect.height;
    
    // Check if container is RTL
    const isRTL = window.getComputedStyle(containerRef.current).direction === 'rtl';
    
    let clientPos: number;
    if (e instanceof MouseEvent) {
      clientPos = isHorizontal ? e.clientX : e.clientY;
    } else {
      // Touch event
      const touch = e.touches[0] || e.changedTouches[0];
      if (!touch) return;
      clientPos = isHorizontal ? touch.clientX : touch.clientY;
    }

    const offset = isHorizontal 
      ? clientPos - containerRect.left
      : clientPos - containerRect.top;
    
    // Calculate ratio from offset
    let newRatio = offset / containerSize;
    
    // In RTL, invert the ratio so dragging right makes first pane (MapPanel) smaller
    // In RTL: first pane is visually on right, dragging right = decreasing ratio
    if (isRTL && isHorizontal) {
      newRatio = 1 - newRatio;
    }
    
    const clampedRatio = clampRatio(newRatio, containerSize);
    
    setRatio(clampedRatio);
    onRatioChange?.(clampedRatio);
  }, [isDragging, direction, clampRatio, onRatioChange]);

  // Handle drag end
  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    if (dividerRef.current) {
      dividerRef.current.releasePointerCapture?.(0);
    }
  }, []);

  // Set up global mouse/touch listeners during drag
  useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.addEventListener('touchmove', handleMouseMove, { passive: false });
      document.addEventListener('touchend', handleMouseUp);
      document.addEventListener('touchcancel', handleMouseUp);
      
      // Prevent text selection and other interactions during drag
      document.body.style.userSelect = 'none';
      document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';
      
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.removeEventListener('touchmove', handleMouseMove);
        document.removeEventListener('touchend', handleMouseUp);
        document.removeEventListener('touchcancel', handleMouseUp);
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
      };
    }
  }, [isDragging, handleMouseMove, handleMouseUp, direction]);

  // Persist ratio to localStorage when it changes
  useEffect(() => {
    if (storageKey) {
      try {
        localStorage.setItem(`${STORAGE_PREFIX}${storageKey}`, ratio.toString());
      } catch (error) {
        console.warn('Failed to save split ratio to localStorage:', error);
      }
    }
  }, [ratio, storageKey]);

  // Handle window resize - maintain ratio but clamp to min sizes
  useEffect(() => {
    const handleResize = () => {
      if (!containerRef.current) return;
      const containerRect = containerRef.current.getBoundingClientRect();
      const isHorizontal = direction === 'horizontal';
      const containerSize = isHorizontal ? containerRect.width : containerRect.height;
      const clampedRatio = clampRatio(ratio, containerSize);
      if (clampedRatio !== ratio) {
        setRatio(clampedRatio);
        onRatioChange?.(clampedRatio);
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [ratio, direction, clampRatio, onRatioChange]);

  const isHorizontal = direction === 'horizontal';
  const firstPaneStyle: React.CSSProperties = {
    [isHorizontal ? 'width' : 'height']: `${ratio * 100}%`,
    [isHorizontal ? 'minWidth' : 'minHeight']: minSizeFirstPx !== null ? `${minSizeFirstPx}px` : undefined,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column'
  };

  const secondPaneStyle: React.CSSProperties = {
    [isHorizontal ? 'width' : 'height']: `${(1 - ratio) * 100}%`,
    [isHorizontal ? 'minWidth' : 'minHeight']: minSizeSecondPx !== null ? `${minSizeSecondPx}px` : undefined,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    flex: 1
  };

  return (
    <div 
      ref={containerRef}
      className={`split-pane split-pane-${direction} ${isDragging ? 'dragging-active' : ''} ${className}`}
      style={{ display: 'flex', flexDirection: isHorizontal ? 'row' : 'column', height: '100%', width: '100%' }}
    >
      <div className="split-pane-first" style={firstPaneStyle}>
        {children[0]}
      </div>
      <div
        ref={dividerRef}
        className={`split-pane-divider ${isDragging ? 'dragging' : ''}`}
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        role="separator"
        aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
        aria-label="Resize panes"
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        tabIndex={0}
        onKeyDown={(e) => {
          // Keyboard support: arrow keys to adjust ratio
          const step = 0.01; // 1% per keypress
          let newRatio = ratio;
          if (isHorizontal) {
            if (e.key === 'ArrowLeft') {
              e.preventDefault();
              newRatio = Math.max(0, ratio - step);
            } else if (e.key === 'ArrowRight') {
              e.preventDefault();
              newRatio = Math.min(1, ratio + step);
            }
          } else {
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              newRatio = Math.max(0, ratio - step);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              newRatio = Math.min(1, ratio + step);
            }
          }
          if (newRatio !== ratio && containerRef.current) {
            const containerRect = containerRef.current.getBoundingClientRect();
            const containerSize = isHorizontal ? containerRect.width : containerRect.height;
            const clampedRatio = clampRatio(newRatio, containerSize);
            setRatio(clampedRatio);
            onRatioChange?.(clampedRatio);
          }
        }}
      />
      <div className="split-pane-second" style={secondPaneStyle}>
        {children[1]}
      </div>
    </div>
  );
};

export default SplitPane;

