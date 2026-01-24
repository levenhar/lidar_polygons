import { useState, useCallback, useRef, useMemo } from 'react';

export type ActionType = 'map' | 'elevation' | 'combined';

export interface UndoRedoOptions {
  // Called when a new action is added to history, allowing registration with global manager
  onActionRegistered?: (
    previousState: any,
    newState: any,
    undo: () => void,
    redo: () => void
  ) => void;
}

export function useUndoRedo<T>(initialState: T, options?: UndoRedoOptions) {
  const [state, setState] = useState<T>(initialState);
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const historyRef = useRef<T[]>([initialState]);
  
  // Flag to track if we're in the middle of an undo/redo operation
  // This prevents registering the same action twice
  const isUndoRedoOperationRef = useRef<boolean>(false);

  // Compute canUndo and canRedo reactively based on currentIndex
  const canUndo = useMemo(() => currentIndex > 0, [currentIndex]);
  const canRedo = useMemo(() => {
    return currentIndex < historyRef.current.length - 1;
  }, [currentIndex]);

  const setStateWithHistory = useCallback((newStateOrUpdater: T | ((prevState: T) => T), addToHistory: boolean = true) => {
    // Support both direct state and functional updates
    const newState = typeof newStateOrUpdater === 'function' 
      ? (newStateOrUpdater as (prevState: T) => T)(state)
      : newStateOrUpdater;
    
    const previousState = state;
    
    if (addToHistory && !isUndoRedoOperationRef.current) {
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
      
      // Notify the global manager about this action
      if (options?.onActionRegistered) {
        // Create undo/redo functions that directly manipulate state
        const undoFn = () => {
          isUndoRedoOperationRef.current = true;
          // Find current index and go back
          const idx = historyRef.current.indexOf(newState);
          if (idx > 0) {
            const prevIdx = idx - 1;
            setCurrentIndex(prevIdx);
            setState(historyRef.current[prevIdx]);
          }
          isUndoRedoOperationRef.current = false;
        };
        
        const redoFn = () => {
          isUndoRedoOperationRef.current = true;
          // Find previous state index and go forward
          const idx = historyRef.current.indexOf(previousState);
          if (idx >= 0 && idx < historyRef.current.length - 1) {
            const nextIdx = idx + 1;
            setCurrentIndex(nextIdx);
            setState(historyRef.current[nextIdx]);
          }
          isUndoRedoOperationRef.current = false;
        };
        
        options.onActionRegistered(previousState, newState, undoFn, redoFn);
      }
    }
    
    setState(newState);
  }, [currentIndex, state, options]);

  const undo = useCallback(() => {
    if (currentIndex > 0) {
      isUndoRedoOperationRef.current = true;
      const newIndex = currentIndex - 1;
      const previousState = historyRef.current[newIndex];
      setCurrentIndex(newIndex);
      setState(previousState);
      isUndoRedoOperationRef.current = false;
    }
  }, [currentIndex]);

  const redo = useCallback(() => {
    if (currentIndex < historyRef.current.length - 1) {
      isUndoRedoOperationRef.current = true;
      const newIndex = currentIndex + 1;
      const nextState = historyRef.current[newIndex];
      setCurrentIndex(newIndex);
      setState(nextState);
      isUndoRedoOperationRef.current = false;
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

