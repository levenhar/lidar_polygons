import { useState, useCallback, useRef } from 'react';

export function useUndoRedo<T>(initialState: T) {
  const [state, setState] = useState<T>(initialState);
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const historyRef = useRef<T[]>([initialState]);

  const canUndo = currentIndex > 0;
  const canRedo = currentIndex < historyRef.current.length - 1;

  const setStateWithHistory = useCallback((newState: T, addToHistory: boolean = true) => {
    if (addToHistory) {
      // Remove any future history if we're not at the end
      if (currentIndex < historyRef.current.length - 1) {
        historyRef.current = historyRef.current.slice(0, currentIndex + 1);
      }
      
      // Add new state to history
      historyRef.current.push(newState);
      const newIndex = historyRef.current.length - 1;
      
      // Limit history size to prevent memory issues (keep last 50 states)
      if (historyRef.current.length > 50) {
        historyRef.current = historyRef.current.slice(-50);
        setCurrentIndex(historyRef.current.length - 1);
      } else {
        setCurrentIndex(newIndex);
      }
    }
    
    setState(newState);
  }, [currentIndex]);

  const undo = useCallback(() => {
    if (currentIndex > 0) {
      const newIndex = currentIndex - 1;
      setCurrentIndex(newIndex);
      setState(historyRef.current[newIndex]);
    }
  }, [currentIndex]);

  const redo = useCallback(() => {
    if (currentIndex < historyRef.current.length - 1) {
      const newIndex = currentIndex + 1;
      setCurrentIndex(newIndex);
      setState(historyRef.current[newIndex]);
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

