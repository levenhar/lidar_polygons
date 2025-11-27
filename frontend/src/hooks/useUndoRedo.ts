import { useState, useCallback, useRef, useMemo } from 'react';

export function useUndoRedo<T>(initialState: T) {
  const [state, setState] = useState<T>(initialState);
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const historyRef = useRef<T[]>([initialState]);

  // Compute canUndo and canRedo reactively based on currentIndex
  const canUndo = useMemo(() => currentIndex > 0, [currentIndex]);
  const canRedo = useMemo(() => {
    return currentIndex < historyRef.current.length - 1;
  }, [currentIndex]);

  const setStateWithHistory = useCallback((newState: T, addToHistory: boolean = true) => {
    if (addToHistory) {
      // Remove any future history if we're not at the end
      if (currentIndex < historyRef.current.length - 1) {
        historyRef.current = historyRef.current.slice(0, currentIndex + 1);
      }
      
      // Add new state to history
      historyRef.current.push(newState);
      
      // Limit history size to prevent memory issues (keep last 50 states)
      const maxHistorySize = 50;
      if (historyRef.current.length > maxHistorySize) {
        // Remove oldest entries, keeping the most recent ones
        const itemsToRemove = historyRef.current.length - maxHistorySize;
        historyRef.current = historyRef.current.slice(itemsToRemove);
        // Adjust currentIndex to account for removed items
        const newIndex = historyRef.current.length - 1;
        setCurrentIndex(newIndex);
      } else {
        // Normal case: just update index to the new state
        const newIndex = historyRef.current.length - 1;
        setCurrentIndex(newIndex);
      }
    }
    
    setState(newState);
  }, [currentIndex]);

  const undo = useCallback(() => {
    if (currentIndex > 0) {
      const newIndex = currentIndex - 1;
      const previousState = historyRef.current[newIndex];
      setCurrentIndex(newIndex);
      setState(previousState);
    }
  }, [currentIndex]);

  const redo = useCallback(() => {
    if (currentIndex < historyRef.current.length - 1) {
      const newIndex = currentIndex + 1;
      const nextState = historyRef.current[newIndex];
      setCurrentIndex(newIndex);
      setState(nextState);
    }
  }, [currentIndex]);

  const resetHistory = useCallback((newState: T) => {
    historyRef.current = [newState];
    setCurrentIndex(0);
    setState(newState);
  }, []);

  return {
    state,
    setState: setStateWithHistory,
    undo,
    redo,
    canUndo,
    canRedo,
    resetHistory
  };
}

